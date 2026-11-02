import { describe, test, expect } from "bun:test";
import {
  svelteFlowToWorkflow,
  workflowToSvelteFlow,
  buildNodeNameMap,
} from "../../../src/utils/workflow-conversion";
import type {
  INode,
  IConnections,
  ISvelteFlowNode,
  ISvelteFlowEdge,
} from "@agentpod/types";

describe("Workflow Conversion Utilities", () => {
  describe("svelteFlowToWorkflow", () => {
    test("should convert empty arrays to empty workflow", () => {
      const result = svelteFlowToWorkflow([], []);

      expect(result.nodes).toEqual([]);
      expect(result.connections).toEqual({});
    });

    test("should convert single node without edges", () => {
      const svelteNodes: ISvelteFlowNode[] = [
        {
          id: "node-1",
          type: "manual-trigger",
          position: { x: 100, y: 200 },
          data: { label: "Start Trigger" },
        },
      ];

      const result = svelteFlowToWorkflow(svelteNodes, []);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]?.id).toBe("node-1");
      expect(result.nodes[0]?.name).toBe("Start Trigger");
      expect(result.nodes[0]?.type).toBe("manual-trigger");
      expect(result.nodes[0]?.position).toEqual([100, 200]);
      expect(result.connections).toEqual({});
    });

    test("should convert two connected nodes", () => {
      const svelteNodes: ISvelteFlowNode[] = [
        {
          id: "node-1",
          type: "manual-trigger",
          position: { x: 0, y: 0 },
          data: { label: "Trigger" },
        },
        {
          id: "node-2",
          type: "http-request",
          position: { x: 200, y: 0 },
          data: { label: "HTTP Request", url: "https://api.example.com" },
        },
      ];

      const svelteEdges: ISvelteFlowEdge[] = [
        { id: "e1-2", source: "node-1", target: "node-2" },
      ];

      const result = svelteFlowToWorkflow(svelteNodes, svelteEdges);

      expect(result.nodes).toHaveLength(2);
      expect(result.connections["Trigger"]).toBeDefined();
      expect(result.connections["Trigger"]?.main[0]).toHaveLength(1);
      expect(result.connections["Trigger"]?.main[0]?.[0]?.node).toBe("HTTP Request");
    });

    test("should convert node with multiple outputs", () => {
      const svelteNodes: ISvelteFlowNode[] = [
        {
          id: "cond-1",
          type: "condition",
          position: { x: 0, y: 0 },
          data: { label: "Condition" },
        },
        {
          id: "true-branch",
          type: "http-request",
          position: { x: 200, y: -100 },
          data: { label: "True Branch" },
        },
        {
          id: "false-branch",
          type: "http-request",
          position: { x: 200, y: 100 },
          data: { label: "False Branch" },
        },
      ];

      const svelteEdges: ISvelteFlowEdge[] = [
        { id: "e1", source: "cond-1", target: "true-branch" },
        { id: "e2", source: "cond-1", target: "false-branch" },
      ];

      const result = svelteFlowToWorkflow(svelteNodes, svelteEdges);

      expect(result.connections["Condition"]?.main[0]).toHaveLength(2);
    });

    test("should preserve node parameters in data", () => {
      const svelteNodes: ISvelteFlowNode[] = [
        {
          id: "ai-1",
          type: "ai-agent",
          position: { x: 0, y: 0 },
          data: {
            label: "AI Agent",
            prompt: "Summarize this text",
            model: { providerId: "anthropic", modelId: "claude-3" },
            timeout: 30000,
          },
        },
      ];

      const result = svelteFlowToWorkflow(svelteNodes, []);

      expect(result.nodes[0]?.parameters.prompt).toBe("Summarize this text");
      expect(result.nodes[0]?.parameters.model).toEqual({
        providerId: "anthropic",
        modelId: "claude-3",
      });
      expect(result.nodes[0]?.parameters.timeout).toBe(30000);
    });

    test("should use node id as name if label is missing", () => {
      const svelteNodes: ISvelteFlowNode[] = [
        {
          id: "node-abc123",
          type: "manual-trigger",
          position: { x: 0, y: 0 },
          data: {},
        },
      ];

      const result = svelteFlowToWorkflow(svelteNodes, []);

      expect(result.nodes[0]?.name).toBe("node-abc123");
    });

    test("should handle complex workflow with multiple paths", () => {
      const svelteNodes: ISvelteFlowNode[] = [
        { id: "1", type: "manual-trigger", position: { x: 0, y: 0 }, data: { label: "Start" } },
        { id: "2", type: "ai-agent", position: { x: 200, y: 0 }, data: { label: "AI Process" } },
        { id: "3", type: "condition", position: { x: 400, y: 0 }, data: { label: "Check Result" } },
        { id: "4", type: "approval", position: { x: 600, y: -100 }, data: { label: "Get Approval" } },
        { id: "5", type: "http-request", position: { x: 600, y: 100 }, data: { label: "Send Result" } },
        { id: "6", type: "notification", position: { x: 800, y: 0 }, data: { label: "Notify" } },
      ];

      const svelteEdges: ISvelteFlowEdge[] = [
        { id: "e1-2", source: "1", target: "2" },
        { id: "e2-3", source: "2", target: "3" },
        { id: "e3-4", source: "3", target: "4" },
        { id: "e3-5", source: "3", target: "5" },
        { id: "e4-6", source: "4", target: "6" },
        { id: "e5-6", source: "5", target: "6" },
      ];

      const result = svelteFlowToWorkflow(svelteNodes, svelteEdges);

      expect(result.nodes).toHaveLength(6);
      expect(Object.keys(result.connections)).toHaveLength(5);
      expect(result.connections["Check Result"]?.main[0]).toHaveLength(2);
    });
  });

  describe("workflowToSvelteFlow", () => {
    test("should convert empty workflow to empty arrays", () => {
      const workflow = {
        id: "wf-1",
        name: "Empty Workflow",
        active: false,
        nodes: [],
        connections: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      };

      const result = workflowToSvelteFlow(workflow);

      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
    });

    test("should convert single node", () => {
      const workflow = {
        id: "wf-1",
        name: "Single Node",
        active: false,
        nodes: [
          {
            id: "node-1",
            name: "Trigger",
            type: "manual-trigger" as const,
            position: [100, 200] as [number, number],
            parameters: { label: "Start" },
          },
        ],
        connections: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      };

      const result = workflowToSvelteFlow(workflow);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]?.id).toBe("node-1");
      expect(result.nodes[0]?.type).toBe("manual-trigger");
      expect(result.nodes[0]?.position).toEqual({ x: 100, y: 200 });
      expect(result.nodes[0]?.data.label).toBe("Trigger");
    });

    test("should convert workflow with connections to edges", () => {
      const workflow = {
        id: "wf-1",
        name: "Connected Workflow",
        active: false,
        nodes: [
          {
            id: "node-1",
            name: "Trigger",
            type: "manual-trigger" as const,
            position: [0, 0] as [number, number],
            parameters: {},
          },
          {
            id: "node-2",
            name: "HTTP Request",
            type: "http-request" as const,
            position: [200, 0] as [number, number],
            parameters: { url: "https://api.example.com" },
          },
        ],
        connections: {
          Trigger: {
            main: [[{ node: "HTTP Request", type: "main", index: 0 }]],
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      };

      const result = workflowToSvelteFlow(workflow);

      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]?.source).toBe("node-1");
      expect(result.edges[0]?.target).toBe("node-2");
    });

    test("should preserve node parameters", () => {
      const workflow = {
        id: "wf-1",
        name: "AI Workflow",
        active: false,
        nodes: [
          {
            id: "ai-1",
            name: "AI Agent",
            type: "ai-chat" as const,
            position: [0, 0] as [number, number],
            parameters: {
              prompt: "Analyze this",
              model: { providerId: "openai", modelId: "gpt-4" },
            },
          },
        ],
        connections: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      };

      const result = workflowToSvelteFlow(workflow);

      expect(result.nodes[0]?.data.prompt).toBe("Analyze this");
      expect(result.nodes[0]?.data.model).toEqual({
        providerId: "openai",
        modelId: "gpt-4",
      });
    });

    test("should handle node with multiple output connections", () => {
      const workflow = {
        id: "wf-1",
        name: "Branching Workflow",
        active: false,
        nodes: [
          { id: "c-1", name: "Condition", type: "condition" as const, position: [0, 0] as [number, number], parameters: {} },
          { id: "t-1", name: "True Path", type: "http-request" as const, position: [200, -100] as [number, number], parameters: {} },
          { id: "f-1", name: "False Path", type: "http-request" as const, position: [200, 100] as [number, number], parameters: {} },
        ],
        connections: {
          Condition: {
            main: [
              [
                { node: "True Path", type: "main", index: 0 },
                { node: "False Path", type: "main", index: 0 },
              ],
            ],
          },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      };

      const result = workflowToSvelteFlow(workflow);

      expect(result.edges).toHaveLength(2);
      expect(result.edges.find(e => e.target === "t-1")).toBeDefined();
      expect(result.edges.find(e => e.target === "f-1")).toBeDefined();
    });
  });

  describe("buildNodeNameMap", () => {
    test("should build empty map for empty array", () => {
      const result = buildNodeNameMap([]);
      expect(result.size).toBe(0);
    });

    test("should map node names to ids", () => {
      const nodes: INode[] = [
        { id: "n1", name: "First Node", type: "manual-trigger", position: [0, 0], parameters: {} },
        { id: "n2", name: "Second Node", type: "http-request", position: [100, 0], parameters: {} },
      ];

      const result = buildNodeNameMap(nodes);

      expect(result.get("First Node")).toBe("n1");
      expect(result.get("Second Node")).toBe("n2");
    });

    test("should handle nodes with same names (last wins)", () => {
      const nodes: INode[] = [
        { id: "n1", name: "Duplicate", type: "manual-trigger", position: [0, 0], parameters: {} },
        { id: "n2", name: "Duplicate", type: "http-request", position: [100, 0], parameters: {} },
      ];

      const result = buildNodeNameMap(nodes);

      expect(result.get("Duplicate")).toBe("n2");
    });
  });

  describe("Round-trip conversion", () => {
    test("should preserve data through round-trip (SvelteFlow -> Workflow -> SvelteFlow)", () => {
      const originalNodes: ISvelteFlowNode[] = [
        {
          id: "trigger-1",
          type: "manual-trigger",
          position: { x: 0, y: 0 },
          data: { label: "Start" },
        },
        {
          id: "ai-1",
          type: "ai-agent",
          position: { x: 200, y: 0 },
          data: { label: "Process", prompt: "Hello" },
        },
      ];

      const originalEdges: ISvelteFlowEdge[] = [
        { id: "e1", source: "trigger-1", target: "ai-1" },
      ];

      const workflow = svelteFlowToWorkflow(originalNodes, originalEdges);

      const workflowBase = {
        id: "wf-roundtrip",
        name: "Round Trip Test",
        active: false,
        nodes: workflow.nodes,
        connections: workflow.connections,
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      };

      const result = workflowToSvelteFlow(workflowBase);

      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);

      const triggerNode = result.nodes.find(n => n.type === "manual-trigger");
      const aiNode = result.nodes.find(n => n.type === "ai-agent");

      expect(triggerNode?.data.label).toBe("Start");
      expect(aiNode?.data.label).toBe("Process");
      expect(aiNode?.data.prompt).toBe("Hello");
    });

    test("should preserve complex workflow through round-trip", () => {
      const originalNodes: ISvelteFlowNode[] = [
        { id: "1", type: "webhook-trigger", position: { x: 0, y: 0 }, data: { label: "Webhook", path: "/hook" } },
        { id: "2", type: "ai-agent", position: { x: 200, y: 0 }, data: { label: "Analyze" } },
        { id: "3", type: "condition", position: { x: 400, y: 0 }, data: { label: "Check" } },
        { id: "4", type: "approval", position: { x: 600, y: -100 }, data: { label: "Approve" } },
        { id: "5", type: "http-request", position: { x: 600, y: 100 }, data: { label: "API Call" } },
      ];

      const originalEdges: ISvelteFlowEdge[] = [
        { id: "e1-2", source: "1", target: "2" },
        { id: "e2-3", source: "2", target: "3" },
        { id: "e3-4", source: "3", target: "4" },
        { id: "e3-5", source: "3", target: "5" },
      ];

      const workflow = svelteFlowToWorkflow(originalNodes, originalEdges);
      const workflowBase = {
        id: "wf-complex",
        name: "Complex",
        active: false,
        nodes: workflow.nodes,
        connections: workflow.connections,
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      };

      const result = workflowToSvelteFlow(workflowBase);

      expect(result.nodes).toHaveLength(5);
      expect(result.edges).toHaveLength(4);

      const checkConnections = result.edges.filter(e => e.source === "3");
      expect(checkConnections).toHaveLength(2);
    });
  });
});
