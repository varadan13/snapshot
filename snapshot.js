const NodeType = {
  Document: 0,
  DocumentType: 1,
  Element: 2,
  Text: 3,
  CDATA: 4,
  Comment: 5,
};

let _id = 1;

function genId() {
  return _id++;
}

function getCssRulesString(styleSheet) {
  try {
    const rules = styleSheet.cssRules || styleSheet.rules;
    if (!rules) return "";

    let css = "";
    for (const rule of rules) {
      css += rule.cssText + "\n";
    }
    return css;
  } catch (e) {
    // cross-origin stylesheet
    return "";
  }
}

function serializeNode(n) {
  switch (n.nodeType) {
    case n.DOCUMENT_NODE:
      return {
        type: NodeType.Document,
        childNodes: [],
      };

    case n.DOCUMENT_TYPE_NODE:
      return {
        type: NodeType.DocumentType,
        name: n.name,
        publicId: n.publicId,
        systemId: n.systemId,
      };

    case n.ELEMENT_NODE:
      const tagName = n.tagName.toLowerCase();
      const attributes = {};

      for (const { name, value } of Array.from(n.attributes)) {
        if (name === "href" || name === "src") {
          attributes[name] = value.startsWith("/")
            ? new URL(value, window.origin).toString()
            : value;
        } else {
          attributes[name] = value;
        }
      }

      // ---------- Stylesheet handling ----------

      if (tagName === "link" && attributes.rel === "stylesheet") {
        const sheet = Array.from(document.styleSheets).find(
          (s) => s.href === n.href,
        );

        if (sheet) {
          const cssText = getCssRulesString(sheet);
          if (cssText) {
            attributes._cssText = cssText;
          }
        }
      }

      if (tagName === "style") {
        const sheet = n.sheet;
        const cssText = getCssRulesString(sheet);
        if (cssText) {
          attributes._cssText = cssText;
        }
      }

      // ---------- Inputs ----------

      if (tagName === "input" || tagName === "textarea") {
        attributes.value = n.value;
      }

      if (
        tagName === "input" &&
        (n.type === "checkbox" || n.type === "radio")
      ) {
        if (n.checked) attributes.checked = true;
      }

      if (tagName === "select") {
        attributes.value = n.value;
      }

      // ---------- Canvas ----------

      if (tagName === "canvas") {
        try {
          attributes.rr_dataURL = n.toDataURL();
        } catch (e) {}
      }

      // ---------- Scroll ----------

      if (n.scrollTop) attributes.scrollTop = n.scrollTop;
      if (n.scrollLeft) attributes.scrollLeft = n.scrollLeft;

      return {
        type: NodeType.Element,
        tagName,
        attributes,
        childNodes: [],
      };

    case n.TEXT_NODE:
      const parentTagName =
        n.parentNode && n.parentNode.tagName ? n.parentNode.tagName : undefined;

      let textContent = n.textContent;

      if (parentTagName === "SCRIPT") {
        textContent = "";
      }

      return {
        type: NodeType.Text,
        textContent,
      };

    case n.CDATA_SECTION_NODE:
      return {
        type: NodeType.CDATA,
        textContent: "",
      };

    case n.COMMENT_NODE:
      return {
        type: NodeType.Comment,
        textContent: n.textContent,
      };

    default:
      return false;
  }
}

function snapshot(n) {
  const _serializedNode = serializeNode(n);

  if (!_serializedNode) {
    console.warn(n, "not serialized");
    return null;
  }

  const serializedNode = Object.assign(_serializedNode, {
    id: genId(),
  });

  if (
    serializedNode.type === NodeType.Document ||
    serializedNode.type === NodeType.Element
  ) {
    for (const childN of Array.from(n.childNodes)) {
      const child = snapshot(childN);
      if (child) {
        serializedNode.childNodes.push(child);
      }
    }
  }

  return serializedNode;
}

export default snapshot;
