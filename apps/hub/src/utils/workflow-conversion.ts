import type {
  INode,
  IConnections,
  IWorkflowBase,
  ISvelteFlowNode,
  ISvelteFlowEdge,
  WorkflowNodeType,
} from "@agentpod/types";

export function svelteFlowToWorkflow(
  svelteNodes: ISvelteFlowNode[],
  svelteEdges: ISvelteFlowEdge[]
): { nodes: INode[]; connections: IConnections } {
  const nodes: INode[] = svelteNodes.map((node) => {
    const { label, ...parameters } = node.data;
    return {
      id: node.id,
      name: (label as string) || node.id,
      type: node.type as WorkflowNodeType,
      position: [node.position.x, node.position.y] as [number, number],
      parameters: { label, ...parameters },
    };
  });

  const nodeIdToName = new Map<string, string>();
  for (const node of nodes) {
    nodeIdToName.set(node.id, node.name);
  }

  const connections: IConnections = {};

  for (const edge of svelteEdges) {
    const sourceName = nodeIdToName.get(edge.source);
    const targetName = nodeIdToName.get(edge.target);

    if (!sourceName || !targetName) continue;

    if (!connections[sourceName]) {
      connections[sourceName] = { main: [] };
    }
    const sourceConn = connections[sourceName];

    const handleType = edge.sourceHandle || "main";
    
    let handleIndex = sourceConn.main.findIndex(group => 
      group.length > 0 && group[0]?.type === handleType
    );
    
    if (handleIndex === -1) {
      handleIndex = sourceConn.main.length;
      sourceConn.main.push([]);
    }

    const handleGroup = sourceConn.main[handleIndex];
    if (handleGroup) {
      handleGroup.push({
        node: targetName,
        type: handleType,
        index: handleGroup.length,
      });
    }
  }

  return { nodes, connections };
}

export function workflowToSvelteFlow(workflow: IWorkflowBase): {
  nodes: ISvelteFlowNode[];
  edges: ISvelteFlowEdge[];
} {
  const nodes: ISvelteFlowNode[] = workflow.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: { x: node.position[0], y: node.position[1] },
    data: {
      ...node.parameters,
      label: node.name,
    },
  }));

  const nameToId = buildNodeNameMap(workflow.nodes);
  const edges: ISvelteFlowEdge[] = [];
  let edgeIndex = 0;

  for (const [sourceName, nodeConnections] of Object.entries(
    workflow.connections
  )) {
    const sourceId = nameToId.get(sourceName);
    if (!sourceId) continue;

    for (const outputConnections of nodeConnections.main) {
      for (const connection of outputConnections) {
        const targetId = nameToId.get(connection.node);
        if (!targetId) continue;

        edges.push({
          id: `e-${sourceId}-${targetId}-${edgeIndex++}`,
          source: sourceId,
          target: targetId,
          sourceHandle: connection.type !== "main" ? connection.type : undefined,
        });
      }
    }
  }

  return { nodes, edges };
}

export function buildNodeNameMap(nodes: INode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of nodes) {
    map.set(node.name, node.id);
  }
  return map;
}
