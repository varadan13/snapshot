// ─── Enums ───────────────────────────────────────────────────────────────────

const EventType = {
  DomContentLoaded: 0,
  Load: 1,
  FullSnapshot: 2,
  IncrementalSnapshot: 3,
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

// ─── Utils (utils.ts) ────────────────────────────────────────────────────────

// mirror maps serialised node IDs ↔ live DOM nodes.
// Nodes must be tagged with .__sn = { id } during snapshot for getId to work.
const mirror = {
  map: {},
  getId(n) {
    return n.__sn && n.__sn.id;
  },
  getNode(id) {
    return mirror.map[id];
  },
};

function on(type, fn, target = document) {
  target.addEventListener(type, fn, { capture: true, passive: true });
  return () => target.removeEventListener(type, fn);
}

// Throttle — adapted from Underscore.js (same as rrweb's utils.ts)
function throttle(func, wait, options = {}) {
  let timeout = null;
  let previous = 0;
  return function () {
    const now = Date.now();
    if (!previous && options.leading === false) {
      previous = now;
    }
    const remaining = wait - (now - previous);
    const context = this;
    const args = arguments;
    if (remaining <= 0 || remaining > wait) {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
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

// ─── Observers (observer.ts) ─────────────────────────────────────────────────

function initMutationObserver(cb) {
  const observer = new MutationObserver(mutations => {
    const texts = [];
    const attributes = [];
    const removes = [];
    const adds = [];

    mutations.forEach(mutation => {
      const {
        type,
        target,
        oldValue,
        addedNodes,
        removedNodes,
        attributeName,
        nextSibling,
        previousSibling,
      } = mutation;

      const id = mirror.getId(target);

      switch (type) {
        case 'characterData': {
          const value = target.textContent;
          if (value !== oldValue) {
            texts.push({ id, value });
          }
          break;
        }
        case 'attributes': {
          const value = target.getAttribute(attributeName);
          if (value === oldValue) return;
          let item = attributes.find(a => a.id === id);
          if (!item) {
            item = { id, attributes: {} };
            attributes.push(item);
          }
          item.attributes[attributeName] = value;
          break;
        }
        case 'childList': {
          removedNodes.forEach(n => {
            removes.push({ parentId: id, id: mirror.getId(n) });
          });
          addedNodes.forEach(n => {
            adds.push({
              parentId: id,
              previousId: previousSibling ? mirror.getId(previousSibling) : null,
              nextId: nextSibling ? mirror.getId(nextSibling) : null,
              id: mirror.getId(n),
            });
          });
          break;
        }
      }
    });

    cb({ texts, attributes, removes, adds });
  });

  observer.observe(document, {
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true,
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
    cb(
      positions.map(p => {
        p.timeOffset -= totalOffset;
        return p;
      }),
    );
    positions = [];
    timeBaseline = null;
  }, 500);

  const updatePosition = throttle(
    evt => {
      const { clientX, clientY } = evt;
      if (!timeBaseline) {
        timeBaseline = Date.now();
      }
      positions.push({ x: clientX, y: clientY, timeOffset: Date.now() - timeBaseline });
      wrappedCb();
    },
    20,
    { trailing: false },
  );

  return on('mousemove', updatePosition);
}

function initMouseInteractionObserver(cb) {
  const handlers = [];

  const getHandler = eventKey => {
    return evt => {
      const id = mirror.getId(evt.target);
      const { clientX, clientY } = evt;
      cb({ type: MouseInteractions[eventKey], id, x: clientX, y: clientY });
    };
  };

  Object.keys(MouseInteractions)
    .filter(key => isNaN(Number(key)))
    .forEach(eventKey => {
      const eventName = eventKey.toLowerCase();
      handlers.push(on(eventName, getHandler(eventKey)));
    });

  return () => handlers.forEach(h => h());
}

function initScrollObserver(cb) {
  const updatePosition = throttle(evt => {
    if (!evt.target) return;
    const id = mirror.getId(evt.target);
    if (evt.target === document) {
      cb({ id, x: document.documentElement.scrollLeft, y: document.documentElement.scrollTop });
    } else {
      cb({ id, x: evt.target.scrollLeft, y: evt.target.scrollTop });
    }
  }, 100);

  return on('scroll', updatePosition);
}

function initViewportResizeObserver(cb) {
  const updateDimension = throttle(() => {
    const height =
      window.innerHeight ||
      (document.documentElement && document.documentElement.clientHeight) ||
      (document.body && document.body.clientHeight);
    const width =
      window.innerWidth ||
      (document.documentElement && document.documentElement.clientWidth) ||
      (document.body && document.body.clientWidth);
    cb({ width: Number(width), height: Number(height) });
  }, 200);

  return on('resize', updateDimension, window);
}

function initObservers(o) {
  const mutationObserver = initMutationObserver(o.mutationCb);
  const mousemoveHandler = initMousemoveObserver(o.mousemoveCb);
  const mouseInteractionHandler = initMouseInteractionObserver(o.mouseInteractionCb);
  const scrollHandler = initScrollObserver(o.scrollCb);
  const viewportResizeHandler = initViewportResizeObserver(o.viewportResizeCb);
  return { mutationObserver, mousemoveHandler, mouseInteractionHandler, scrollHandler, viewportResizeHandler };
}

// ─── Record (record/index.ts) ────────────────────────────────────────────────

function wrapEvent(e) {
  return { ...e, timestamp: Date.now() };
}

/**
 * record({ emit })
 *
 * Starts recording DOM events and emitting them via the provided emit callback.
 * Each emitted event has a `type`, `data`, and `timestamp`.
 *
 * Depends on snapshot.js being available as `snapshot` in scope.
 * Also requires that snapshot() tags each live DOM node with .__sn = { id }
 * so that mirror.getId() can resolve node IDs during incremental recording.
 */
function record(options) {
  const { emit } = options;
  if (!emit) throw new Error('emit function is required');

  on('DOMContentLoaded', () => {
    emit(wrapEvent({ type: EventType.DomContentLoaded, data: { href: window.location.href } }));
  });

  on('load', () => {
    emit(wrapEvent({ type: EventType.Load, data: {} }));

    const node = snapshot(document);
    if (!node) {
      console.warn('Failed to snapshot the document');
      return;
    }

    emit(wrapEvent({ type: EventType.FullSnapshot, data: { node } }));

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
    });
  }, window);
}

export { EventType, IncrementalSource, MouseInteractions, mirror };
export default record;
