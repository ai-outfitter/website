import mermaid from "mermaid";

export type WorkflowDiagramNode = {
  id: string;
  title: string;
  kind: "step" | "workflow";
  href?: string;
  details: Array<{ label: string; value: string }>;
};

let initialized = false;
const narrowScreen = typeof matchMedia === "function" ? matchMedia("(max-width: 50rem)") : null;

function initialize() {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: { background: "transparent", fontSize: "17px" },
    flowchart: { curve: "basis", htmlLabels: true, padding: 20, useMaxWidth: false },
  });
  initialized = true;
}

function showNodeDetails(dialog: HTMLDialogElement, node: WorkflowDiagramNode) {
  const heading = dialog.querySelector<HTMLElement>("[data-node-title]");
  const details = dialog.querySelector<HTMLElement>("[data-node-details]");
  if (!heading || !details) return;
  heading.textContent = node.title;
  details.replaceChildren(...node.details.flatMap((detail) => {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = detail.label;
    description.textContent = detail.value;
    return [term, description];
  }));
  dialog.showModal();
}

function renderWorkflowTimeline(canvas: HTMLElement, nodes: WorkflowDiagramNode[], dialog: HTMLDialogElement) {
  const list = document.createElement("ol");
  list.className = "workflow-diagram__steps";
  for (const node of nodes) {
    const item = document.createElement("li");
    item.className = "workflow-diagram__step";
    const marker = document.createElement("span");
    marker.className = "workflow-diagram__step-marker";
    marker.setAttribute("aria-hidden", "true");
    item.appendChild(marker);
    if (node !== nodes.at(-1)) {
      const connector = document.createElement("span");
      connector.className = "workflow-diagram__step-connector";
      connector.setAttribute("aria-hidden", "true");
      item.appendChild(connector);
    }
    const control = document.createElement(node.href ? "a" : "button");
    control.className = "workflow-diagram__step-control";
    if (control instanceof HTMLAnchorElement) control.href = node.href!;
    else {
      control.type = "button";
      control.addEventListener("click", () => showNodeDetails(dialog, node));
    }
    const title = document.createElement("span");
    title.className = "workflow-diagram__step-title";
    title.textContent = node.title;
    control.appendChild(title);
    const description = node.details.find((detail) => detail.label === "Description")?.value;
    if (description) {
      const summary = document.createElement("span");
      summary.className = "workflow-diagram__step-description";
      summary.textContent = description;
      control.appendChild(summary);
    }
    const context = node.details.filter((detail) => detail.label !== "Description").slice(0, 2);
    if (context.length) {
      const metadata = document.createElement("span");
      metadata.className = "workflow-diagram__step-meta";
      metadata.textContent = context.map((detail) => `${detail.label}: ${detail.value}`).join(" · ");
      control.appendChild(metadata);
    }
    item.appendChild(control);
    list.appendChild(item);
  }
  canvas.setAttribute("aria-label", `${diagramTitle(canvas)} workflow steps`);
  canvas.replaceChildren(list);
}

function diagramTitle(canvas: HTMLElement) {
  return canvas.closest<HTMLElement>("[data-workflow-diagram]")?.dataset.workflowTitle ?? "Workflow";
}

export async function renderWorkflowDiagram(diagram: HTMLElement, renderId = "workflow", signal?: AbortSignal, narrowOverride?: boolean) {
  const canvas = diagram.querySelector<HTMLElement>(".workflow-diagram__canvas");
  const data = diagram.querySelector<HTMLElement>("[data-workflow-source]");
  const nodeData = diagram.querySelector<HTMLElement>("[data-workflow-nodes]");
  const status = diagram.querySelector<HTMLElement>(".workflow-diagram__status");
  const dialog = diagram.querySelector<HTMLDialogElement>("[data-workflow-node-dialog]");
  if (!canvas || !data || !nodeData || !status || !dialog) return;
  try {
    const nodes = JSON.parse(nodeData.textContent ?? "[]") as WorkflowDiagramNode[];
    const narrow = narrowOverride ?? narrowScreen?.matches ?? false;
    if (narrow) {
      renderWorkflowTimeline(canvas, nodes, dialog);
      status.textContent = "";
      status.classList.remove("workflow-diagram__error");
      return;
    }
    initialize();
    const source = (data.textContent ?? "").replace(/^flowchart\s+(LR|TB)/, "flowchart LR");
    const rendered = await mermaid.render(`${renderId}-lr`, source);
    if (signal?.aborted) return;
    canvas.innerHTML = rendered.svg;
    rendered.bindFunctions?.(canvas);
    const renderedNodeFor = (nodeId: string) => [...canvas.querySelectorAll<SVGGElement>("g.node")]
      .find((element) => element.id.includes(`flowchart-${nodeId}-`));
    for (const node of nodes) {
      const renderedNode = renderedNodeFor(node.id);
      if (!renderedNode) continue;
      renderedNode.classList.add("workflow-diagram__interactive-node");
      renderedNode.setAttribute("role", node.href ? "link" : "button");
      renderedNode.setAttribute("tabindex", "0");
      renderedNode.setAttribute("aria-label", node.href ? `Open ${node.title} workflow` : `View details for ${node.title}`);
      const activate = () => {
        if (node.href) return window.location.assign(node.href);
        showNodeDetails(dialog, node);
      };
      renderedNode.addEventListener("click", activate);
      renderedNode.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        activate();
      });
    }
    status.textContent = "";
    status.classList.remove("workflow-diagram__error");
  } catch (error) {
    if (signal?.aborted || (error as { name?: string }).name === "AbortError") return;
    canvas.innerHTML = "";
    status.classList.add("workflow-diagram__error");
    status.textContent = `The workflow diagram could not be rendered: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function installWorkflowDiagrams(documentRef: Document = document) {
  const diagrams = [...documentRef.querySelectorAll<HTMLElement>("[data-workflow-diagram]")];
  await Promise.all(diagrams.map((diagram, index) => renderWorkflowDiagram(diagram, `workflow-${index}`)));
}

narrowScreen?.addEventListener("change", () => void installWorkflowDiagrams());
