import type { Task } from "../src/tasks/types.ts";
import webhookSignature from "./webhook-signature/task.ts";

export const TASKS: Task[] = [webhookSignature];
