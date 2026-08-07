import { fixturePipeline } from "./fixtures";
import type { AgentStage } from "../domain/types";

export interface AgentRunService {
  listStages(): Promise<AgentStage[]>;
  retryStage(stageId: string): Promise<AgentStage>;
}

export const agentRunService: AgentRunService = {
  async listStages() {
    return fixturePipeline.map((stage) => ({ ...stage }));
  },
  async retryStage(stageId) {
    const stage = fixturePipeline.find((item) => item.id === stageId);
    if (!stage) {
      throw new Error("Agent stage not found");
    }
    return { ...stage, status: "running" };
  },
};
