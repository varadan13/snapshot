// Extracts resolved CSS text from a stylesheet (handles CSSOM-injected rules, e.g. styled-components)
function getCssRulesString(sheet) {
  try {
    const rules = sheet.cssRules || sheet.rules;
    if (!rules) return '';
    let css = '';
    for (const rule of rules) css += rule.cssText + '\n';
    return css;
  } catch (e) {
    return ''; // cross-origin stylesheet
  }
}

// Builds a unique CSS selector path for any element, e.g. "body > div:nth-of-type(2) > p:nth-of-type(1)"
function getCssSelector(el) {
  const parts = [];
  while (el && el.nodeType === 1 && el.tagName.toLowerCase() !== 'html') {
    let part = el.tagName.toLowerCase();
    if (el.id) {
      part = '#' + CSS.escape(el.id);
      parts.unshift(part);
      break;
    }
    let i = 1;
    let sibling = el.previousElementSibling;
    while (sibling) { if (sibling.tagName === el.tagName) i++; sibling = sibling.previousElementSibling; }
    parts.unshift(part + ':nth-of-type(' + i + ')');
    el = el.parentElement;
  }
  return parts.join(' > ') || el?.tagName?.toLowerCase() || 'body';
}

// Inlines all stylesheets into the clone (both <link rel="stylesheet"> and <style> elements)
function inlineStyles(clone) {
  const liveStyleNodes = Array.from(
    document.querySelectorAll('link[rel="stylesheet"], style'),
  );
  const cloneStyleNodes = Array.from(
    clone.querySelectorAll('link[rel="stylesheet"], style'),
  );

  liveStyleNodes.forEach((liveEl, i) => {
    const cloneEl = cloneStyleNodes[i];
    if (!cloneEl) return;

    let sheet;
    if (liveEl.tagName.toLowerCase() === 'link') {
      sheet = Array.from(document.styleSheets).find(s => s.ownerNode === liveEl);
    } else {
      sheet = liveEl.sheet;
    }

    const cssText = sheet ? getCssRulesString(sheet) : '';
    if (!cssText) return;

    const style = document.createElement('style');
    style.textContent = cssText;
    cloneEl.parentNode.replaceChild(style, cloneEl);
  });
}

// Rewrites relative href/src attributes to absolute URLs
function absolutizeUrls(clone) {
  clone.querySelectorAll('[href], [src]').forEach(el => {
    ['href', 'src'].forEach(attr => {
      const val = el.getAttribute(attr);
      if (!val) return;
      if (val.startsWith('/') && !val.startsWith('//')) {
        try {
          el.setAttribute(attr, new URL(val, window.origin).toString());
        } catch (_) {}
      }
    });
  });
}

// Strips script execution (empty content, remove src) so the replay is static
function stripScripts(clone) {
  clone.querySelectorAll('script').forEach(el => {
    el.textContent = '';
    el.removeAttribute('src');
  });
}

// Syncs live DOM form state (.value, .checked) into the clone's attributes
function syncFormValues(clone) {
  const liveInputs  = Array.from(document.querySelectorAll('input, textarea, select'));
  const cloneInputs = Array.from(clone.querySelectorAll('input, textarea, select'));

  liveInputs.forEach((liveEl, i) => {
    const cloneEl = cloneInputs[i];
    if (!cloneEl) return;
    const tag = liveEl.tagName.toLowerCase();

    if (tag === 'input' || tag === 'textarea') {
      cloneEl.setAttribute('value', liveEl.value);
    }
    if (tag === 'input' && (liveEl.type === 'checkbox' || liveEl.type === 'radio')) {
      if (liveEl.checked) cloneEl.setAttribute('checked', '');
      else cloneEl.removeAttribute('checked');
    }
    if (tag === 'select') {
      Array.from(cloneEl.options).forEach((opt, j) => {
        if (liveEl.options[j]?.selected) opt.setAttribute('selected', '');
        else opt.removeAttribute('selected');
      });
    }
  });
}

// Captures canvas pixel data as data-rr-canvas attributes on the clone
function syncCanvas(clone) {
  const liveCanvases  = Array.from(document.querySelectorAll('canvas'));
  const cloneCanvases = Array.from(clone.querySelectorAll('canvas'));

  liveCanvases.forEach((liveEl, i) => {
    const cloneEl = cloneCanvases[i];
    if (!cloneEl) return;
    try {
      cloneEl.setAttribute('data-rr-canvas', liveEl.toDataURL());
    } catch (_) {}
  });
}

/**
 * captureHtml(root?)
 *
 * Captures a self-contained HTML string of the current page (or a subtree).
 * - Inlines all CSS (CSSOM-aware, catches styled-components / insertRule styles)
 * - Absolutizes href/src relative URLs
 * - Strips script execution
 * - Syncs live form .value / .checked into attributes
 * - Captures canvas pixels as data-rr-canvas attributes
 *
 * root defaults to document.documentElement (full page).
 * Pass document.body for a cheaper body-only incremental capture.
 */
function captureHtml(root) {
  root = root || document.documentElement;
  const clone = root.cloneNode(true);

  if (root === document.documentElement) {
    inlineStyles(clone);
  }

  absolutizeUrls(clone);
  stripScripts(clone);
  syncFormValues(clone);
  syncCanvas(clone);

  const prefix = root === document.documentElement ? '<!DOCTYPE html>' : '';
  return prefix + clone.outerHTML;
}

/**
 * captureBodyHtml()
 * Cheaper incremental capture — body subtree only.
 * Used after each MutationObserver batch.
 */
function captureBodyHtml() {
  return captureHtml(document.body);
}

export { captureHtml, captureBodyHtml, getCssSelector };
export default captureHtml;
