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

export async function renderWorkflowDiagram(diagram: HTMLElement, renderId = "workflow", signal?: AbortSignal) {
  const canvas = diagram.querySelector<HTMLElement>(".workflow-diagram__canvas");
  const data = diagram.querySelector<HTMLElement>("[data-workflow-source]");
  const nodeData = diagram.querySelector<HTMLElement>("[data-workflow-nodes]");
  const status = diagram.querySelector<HTMLElement>(".workflow-diagram__status");
  const dialog = diagram.querySelector<HTMLDialogElement>("[data-workflow-node-dialog]");
  if (!canvas || !data || !nodeData || !status || !dialog) return;
  try {
    initialize();
    const narrow = narrowScreen?.matches ?? false;
    const source = (data.textContent ?? "").replace(/^flowchart\s+(LR|TB)/, `flowchart ${narrow ? "TB" : "LR"}`);
    const rendered = await mermaid.render(`${renderId}-${narrow ? "tb" : "lr"}`, source);
    if (signal?.aborted) return;
    canvas.innerHTML = rendered.svg;
    rendered.bindFunctions?.(canvas);
    const nodes = JSON.parse(nodeData.textContent ?? "[]") as WorkflowDiagramNode[];
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
      };
      renderedNode.addEventListener("click", activate);
      renderedNode.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        activate();
      });
    }
    if (narrow && nodes[0]) {
      const firstNode = renderedNodeFor(nodes[0].id);
      if (firstNode) {
        const canvasBounds = canvas.getBoundingClientRect();
        const nodeBounds = firstNode.getBoundingClientRect();
        canvas.scrollLeft += nodeBounds.left + nodeBounds.width / 2 - canvasBounds.left - canvas.clientWidth / 2;
      }
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
