// SPDX-License-Identifier: Apache-2.0
(() => {
  const vscode = acquireVsCodeApi();
  const tree = document.getElementById("tree"),
    status = document.getElementById("status"),
    empty = document.getElementById("empty");
  const previous = vscode.getState() ?? {};
  const expanded = new Set(Array.isArray(previous.expanded) ? previous.expanded : []);
  let selected = typeof previous.selected === "string" ? previous.selected : "";
  let revision = 0,
    roots = [];
  const nodes = new Map(),
    children = new Map(),
    loading = new Set();
  const save = () => vscode.setState({ expanded: [...expanded], selected });
  const send = (type, node) => vscode.postMessage({ type, node, revision });

  function svg(content) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("viewBox", "0 0 16 16");
    node.setAttribute("aria-hidden", "true");
    node.innerHTML = content;
    return node;
  }
  function load(id) {
    if (!loading.has(id) && !children.has(id)) {
      loading.add(id);
      send("children", id);
    }
  }
  function toggle(node) {
    if (expanded.has(node.id)) expanded.delete(node.id);
    else {
      expanded.add(node.id);
      load(node.id);
    }
    save();
    render(node.id);
  }
  function render(focus) {
    const active =
      focus ??
      (tree.contains(document.activeElement) ? document.activeElement.dataset.node : undefined);
    tree.replaceChildren();
    const visible = [];
    function append(ids, parent, depth) {
      for (const id of ids) {
        const node = nodes.get(id);
        if (!node) continue;
        visible.push(id);
        const row = document.createElement("div");
        row.className = "entry";
        row.dataset.node = id;
        row.dataset.kind = node.kind;
        row.style.paddingLeft = 4 + depth * 12 + "px";
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-level", String(depth + 1));
        row.setAttribute("aria-selected", String(id === selected));
        row.setAttribute("aria-label", [node.label, node.detail].filter(Boolean).join(", "));
        if (node.expandable) row.setAttribute("aria-expanded", String(expanded.has(id)));
        row.tabIndex = id === selected || (!selected && visible.length === 1) ? 0 : -1;
        row.classList.toggle("selected", id === selected);
        row.title = node.tooltip || [node.label, node.detail].filter(Boolean).join("\n");
        row.dataset.vscodeContext = JSON.stringify({
          webviewSection: node.context,
          systraceNode: id,
          preventDefaultContextMenuItems: true,
        });
        const fold = document.createElement(node.expandable ? "button" : "span");
        fold.className = "fold";
        if (node.expandable) {
          fold.type = "button";
          fold.tabIndex = -1;
          fold.setAttribute(
            "aria-label",
            (expanded.has(id) ? "Collapse " : "Expand ") + node.label,
          );
          fold.setAttribute("aria-expanded", String(expanded.has(id)));
          fold.append(svg('<path d="M4 6l4 4 4-4" stroke="currentColor" fill="none"/>'));
          fold.addEventListener("click", (event) => {
            event.stopPropagation();
            toggle(node);
          });
        }
        const icon = document.createElement("span");
        icon.className = "icon";
        for (const theme of ["light", "dark"]) {
          const image = document.createElement("img");
          image.className = `icon-${theme}`;
          image.alt = "";
          image.src = `${tree.dataset[theme === "light" ? "iconsLight" : "iconsDark"]}/${node.icon}.svg`;
          icon.append(image);
        }
        const caption = document.createElement("span");
        caption.className = "caption";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = node.label;
        caption.append(name);
        if (node.detail) {
          const detail = document.createElement("span");
          detail.className = "detail";
          detail.textContent = node.detail;
          caption.append(detail);
        }
        row.append(fold, icon, caption);
        row.addEventListener("click", () => {
          selected = id;
          save();
          send("open", id);
          render(id);
        });
        row.addEventListener("contextmenu", () => {
          selected = id;
          save();
        });
        row.addEventListener("keydown", (event) => {
          const position = visible.indexOf(id);
          let next;
          if (event.key === "ArrowDown") next = visible[position + 1];
          else if (event.key === "ArrowUp") next = visible[position - 1];
          else if (event.key === "Home") next = visible[0];
          else if (event.key === "End") next = visible.at(-1);
          else if (event.key === "ArrowRight" && node.expandable) {
            if (!expanded.has(id)) toggle(node);
            else next = children.get(id)?.[0];
          } else if (event.key === "ArrowLeft") {
            if (expanded.has(id)) toggle(node);
            else next = parent;
          } else if (event.key === "Enter" || event.key === " ") {
            selected = id;
            save();
            send("open", id);
            render(id);
          } else return;
          event.preventDefault();
          if (next) {
            selected = next;
            save();
            render(next);
          }
        });
        tree.append(row);
        if (node.expandable && expanded.has(id)) {
          load(id);
          append(children.get(id) ?? [], id, depth + 1);
        }
      }
    }
    append(roots, undefined, 0);
    empty.hidden = roots.length > 0 || loading.has(null);
    if (active) [...tree.children].find((row) => row.dataset.node === active)?.focus();
  }
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "reset") {
      revision = message.revision;
      nodes.clear();
      children.clear();
      loading.clear();
      roots = [];
      status.textContent = "";
      load(null);
      render();
      return;
    }
    if (message.revision !== revision) return;
    if (message.type === "children") {
      loading.delete(message.parent);
      const ids = message.items.map((node) => {
        nodes.set(node.id, node);
        return node.id;
      });
      children.set(message.parent, ids);
      if (message.parent === null) roots = ids;
      status.textContent = "";
      render();
    } else if (message.type === "error") {
      loading.delete(message.parent);
      children.set(message.parent, []);
      status.textContent = message.message;
      render();
    }
  });
  document
    .querySelectorAll("[data-global]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        vscode.postMessage({ type: "global", action: button.dataset.global }),
      ),
    );
  vscode.postMessage({ type: "ready" });
})();
