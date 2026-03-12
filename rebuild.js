// Deprecated — the replayer now uses morphdom directly against HTML strings.
// The custom JSON snapshot format and manual rebuild are no longer needed.
// Kept for reference only.

const NodeType = {
  Document: 0,
  DocumentType: 1,
  Element: 2,
  Text: 3,
  CDATA: 4,
  Comment: 5,
};

function buildNode(n, doc) {
  switch (n.type) {
    case NodeType.Document:
      return doc;

    case NodeType.DocumentType:
      return doc.implementation.createDocumentType(
        n.name,
        n.publicId,
        n.systemId,
      );

    case NodeType.Element: {
      let node;

      if (n.tagName === "link" && n.attributes?._cssText) {
        node = doc.createElement("style");
        node.textContent = n.attributes._cssText;
      } else if (n.tagName === "style" && n.attributes?._cssText) {
        node = doc.createElement("style");
        node.textContent = n.attributes._cssText;
      } else {
        node = doc.createElement(n.tagName);
      }

      for (const name in n.attributes || {}) {
        if (name === "_cssText") continue;
        if (name === "rr_dataURL") continue;

        node.setAttribute(name, n.attributes[name]);
      }

      if (n.tagName === "input" || n.tagName === "textarea") {
        if (n.attributes?.value !== undefined) {
          node.value = n.attributes.value;
        }
      }

      if (n.tagName === "input" && n.attributes?.checked) {
        node.checked = true;
      }

      if (n.tagName === "select" && n.attributes?.value) {
        node.value = n.attributes.value;
      }

      if (n.tagName === "canvas" && n.attributes?.rr_dataURL) {
        const img = new Image();
        img.onload = function () {
          const ctx = node.getContext("2d");
          ctx.drawImage(img, 0, 0);
        };
        img.src = n.attributes.rr_dataURL;
      }

      return node;
    }

    case NodeType.Text:
      return doc.createTextNode(n.textContent);

    case NodeType.CDATA:
      return doc.createCDATASection(n.textContent);

    case NodeType.Comment:
      return doc.createComment(n.textContent);

    default:
      return null;
  }
}

function rebuild(n, doc) {
  const root = buildNode(n, doc);
  if (!root) return null;

  if (n.type === NodeType.Element) {
    for (const child of n.childNodes || []) {
      const childNode = rebuild(child, doc);

      if (childNode) {
        root.appendChild(childNode);
      }
    }
  }

  return root;
}
