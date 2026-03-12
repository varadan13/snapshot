// ─── Enums ───────────────────────────────────────────────────────────────────

const EventType = {
  DomContentLoaded: 0,
  Load: 1,
  FullSnapshot: 2,
  IncrementalSnapshot: 3,
  Meta: 4,           // URL / navigation change
};

const IncrementalSource = {
  Mutation: 0,
  MouseMove: 1,
  MouseInteraction: 2,
  Scroll: 3,
  ViewportResize: 4,
};

const MouseInteractions = {
  MouseUp: 0,
  MouseDown: 1,
  Click: 2,
  ContextMenu: 3,
  DblClick: 4,
  Focus: 5,
  Blur: 6,
  TouchStart: 7,
  TouchEnd: 8,
};

// ─── Utils ───────────────────────────────────────────────────────────────────

function on(type, fn, target = document) {
  target.addEventListener(type, fn, { capture: true, passive: true });
  return () => target.removeEventListener(type, fn);
}

function throttle(func, wait, options = {}) {
  let timeout = null;
  let previous = 0;
  return function () {
    const now = Date.now();
    if (!previous && options.leading === false) previous = now;
    const remaining = wait - (now - previous);
    const context = this;
    const args = arguments;
    if (remaining <= 0 || remaining > wait) {
      if (timeout) { clearTimeout(timeout); timeout = null; }
      previous = now;
      func.apply(context, args);
    } else if (!timeout && options.trailing !== false) {
      timeout = setTimeout(() => {
        previous = options.leading === false ? 0 : Date.now();
        timeout = null;
        func.apply(context, args);
      }, remaining);
    }
  };
}

// ─── Observers ───────────────────────────────────────────────────────────────

// After each mutation batch, re-capture body HTML and emit it.
// morphdom on the replay side will diff and patch the iframe body.
function initMutationObserver(cb) {
  const observer = new MutationObserver(() => {
    cb({ html: captureBodyHtml() });
  });
  observer.observe(document.body, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  return observer;
}

function initMousemoveObserver(cb) {
  let positions = [];
  let timeBaseline = null;

  const wrappedCb = throttle(() => {
    const totalOffset = Date.now() - timeBaseline;
    cb(positions.map(p => { p.timeOffset -= totalOffset; return p; }));
    positions = [];
    timeBaseline = null;
  }, 500);

  const updatePosition = throttle(evt => {
    const { clientX, clientY } = evt;
    if (!timeBaseline) timeBaseline = Date.now();
    positions.push({ x: clientX, y: clientY, timeOffset: Date.now() - timeBaseline });
    wrappedCb();
  }, 20, { trailing: false });

  return on('mousemove', updatePosition);
}

function initMouseInteractionObserver(cb) {
  const handlers = [];
  const getHandler = eventKey => evt => {
    const { clientX, clientY } = evt;
    cb({ type: MouseInteractions[eventKey], x: clientX, y: clientY });
  };
  Object.keys(MouseInteractions)
    .filter(key => isNaN(Number(key)))
    .forEach(eventKey => handlers.push(on(eventKey.toLowerCase(), getHandler(eventKey))));
  return () => handlers.forEach(h => h());
}

// Scroll — identifies target by CSS selector instead of mirror ID
function initScrollObserver(cb) {
  const updatePosition = throttle(evt => {
    if (!evt.target) return;
    const t = evt.target;
    const selector = (t === document || t === document.documentElement)
      ? 'html'
      : (t.id ? '#' + CSS.escape(t.id) : getCssSelector(t));
    cb({
      selector,
      x: t.scrollLeft ?? (t === document ? document.documentElement.scrollLeft : 0),
      y: t.scrollTop  ?? (t === document ? document.documentElement.scrollTop  : 0),
    });
  }, 100);
  return on('scroll', updatePosition);
}

function initViewportResizeObserver(cb) {
  const updateDimension = throttle(() => {
    const height = window.innerHeight || document.documentElement?.clientHeight || document.body?.clientHeight;
    const width  = window.innerWidth  || document.documentElement?.clientWidth  || document.body?.clientWidth;
    cb({ width: Number(width), height: Number(height) });
  }, 200);
  return on('resize', updateDimension, window);
}

// Navigation — monkey-patches history API + popstate/hashchange.
// pushState/replaceState don't fire any native event so they must be wrapped.
function initNavigationObserver(cb) {
  const origPush    = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);

  history.pushState = (...args) => { origPush(...args);    cb({ href: window.location.href }); };
  history.replaceState = (...args) => { origReplace(...args); cb({ href: window.location.href }); };

  const onNavEvent = () => cb({ href: window.location.href });
  const offPop  = on('popstate',   onNavEvent, window);
  const offHash = on('hashchange', onNavEvent, window);

  return () => {
    history.pushState    = origPush;
    history.replaceState = origReplace;
    offPop();
    offHash();
  };
}

function initObservers(o) {
  const mutationObserver        = initMutationObserver(o.mutationCb);
  const mousemoveHandler        = initMousemoveObserver(o.mousemoveCb);
  const mouseInteractionHandler = initMouseInteractionObserver(o.mouseInteractionCb);
  const scrollHandler           = initScrollObserver(o.scrollCb);
  const viewportResizeHandler   = initViewportResizeObserver(o.viewportResizeCb);
  const navigationHandler       = initNavigationObserver(o.navigationCb);
  return { mutationObserver, mousemoveHandler, mouseInteractionHandler, scrollHandler, viewportResizeHandler, navigationHandler };
}

// ─── Record ──────────────────────────────────────────────────────────────────

function wrapEvent(e) {
  return { ...e, timestamp: Date.now() };
}

/**
 * record({ emit })
 *
 * Starts recording DOM events and emitting them via the provided emit callback.
 *
 * Full snapshot event:    { type: 2, data: { html }, timestamp }
 * Mutation event:         { type: 3, data: { source: 0, html }, timestamp }
 *   html = body.outerHTML after each mutation batch — replayer uses morphdom to patch
 * Scroll event:           { type: 3, data: { source: 3, selector, x, y }, timestamp }
 * Mouse/Resize events:    unchanged — coordinate-based, no node references needed
 *
 * Depends on captureHtml, captureBodyHtml, getCssSelector from snapshot.js being in scope.
 */
function record(options) {
  const { emit } = options;
  if (!emit) throw new Error('emit function is required');

  on('DOMContentLoaded', () => {
    emit(wrapEvent({ type: EventType.DomContentLoaded, data: { href: window.location.href } }));
  });

  // Hard navigation — JS context will be destroyed after this fires
  on('beforeunload', () => {
    emit(wrapEvent({ type: EventType.Meta, data: { href: window.location.href, unloading: true } }));
  }, window);

  on('load', () => {
    emit(wrapEvent({ type: EventType.Load, data: {} }));

    const html = captureHtml();
    if (!html) { console.warn('captureHtml returned empty'); return; }

    emit(wrapEvent({ type: EventType.FullSnapshot, data: { html } }));

    initObservers({
      mutationCb: m =>
        emit(wrapEvent({ type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.Mutation, ...m } })),
      mousemoveCb: positions =>
        emit(wrapEvent({ type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.MouseMove, positions } })),
      mouseInteractionCb: d =>
        emit(wrapEvent({ type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.MouseInteraction, ...d } })),
      scrollCb: p =>
        emit(wrapEvent({ type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.Scroll, ...p } })),
      viewportResizeCb: d =>
        emit(wrapEvent({ type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.ViewportResize, ...d } })),
      navigationCb: d =>
        emit(wrapEvent({ type: EventType.Meta, data: d })),
    });
  }, window);
}

export { EventType, IncrementalSource, MouseInteractions };
export default record;
