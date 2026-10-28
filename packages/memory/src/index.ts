import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

type Note = { at: string; text: string };

const State = Annotation.Root({
  notes: Annotation<Note[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

export type Checkpointer = MemorySaver | { setup?: () => Promise<void> };

export async function createCheckpointer(databaseUrl?: string): Promise<MemorySaver> {
  if (!databaseUrl) return new MemorySaver();
  const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
  const saver = PostgresSaver.fromConnString(databaseUrl, { schema: "langgraph" });
  await saver.setup();
  return saver as unknown as MemorySaver;
}

export function compileMemoryGraph(checkpointer: MemorySaver) {
  return new StateGraph(State)
    .addNode("record", () => ({}))
    .addEdge(START, "record")
    .addEdge("record", END)
    .compile({ checkpointer });
}

export class TaskMemory {
  private graph: ReturnType<typeof compileMemoryGraph>;
  constructor(checkpointer: MemorySaver) {
    this.graph = compileMemoryGraph(checkpointer);
  }
  async remember(threadId: string, text: string): Promise<void> {
    await this.graph.invoke({ notes: [{ at: new Date().toISOString(), text }] }, { configurable: { thread_id: threadId } });
  }
  async recall(threadId: string): Promise<Note[]> {
    const state = await this.graph.getState({ configurable: { thread_id: threadId } });
    return state.values.notes ?? [];
  }
}
