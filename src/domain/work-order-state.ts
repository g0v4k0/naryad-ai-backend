import { WorkOrderStatus } from "@prisma/client";

export type WorkOrderAction =
  | "ACCEPT"
  | "QUEUE"
  | "REJECT"
  | "START"
  | "PAUSE"
  | "RESUME"
  | "COMPLETE"
  | "SEND_TO_REWORK"
  | "CLOSE"
  | "CANCEL";

const transitions: Record<WorkOrderAction, WorkOrderStatus[]> = {
  ACCEPT: [WorkOrderStatus.ISSUED, WorkOrderStatus.QUEUED],
  QUEUE: [WorkOrderStatus.ISSUED],
  REJECT: [WorkOrderStatus.ISSUED],
  START: [WorkOrderStatus.ACCEPTED, WorkOrderStatus.QUEUED, WorkOrderStatus.REWORK],
  PAUSE: [WorkOrderStatus.IN_PROGRESS],
  RESUME: [WorkOrderStatus.PAUSED],
  COMPLETE: [WorkOrderStatus.IN_PROGRESS],
  SEND_TO_REWORK: [WorkOrderStatus.AI_REVIEW],
  CLOSE: [WorkOrderStatus.AI_REVIEW],
  // The master may stop any unfinished order, including one in progress or sent back for rework.
  CANCEL: [WorkOrderStatus.ISSUED, WorkOrderStatus.ACCEPTED, WorkOrderStatus.QUEUED, WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.PAUSED, WorkOrderStatus.REWORK]
};

const targets: Record<WorkOrderAction, WorkOrderStatus> = {
  ACCEPT: WorkOrderStatus.ACCEPTED,
  QUEUE: WorkOrderStatus.QUEUED,
  REJECT: WorkOrderStatus.REJECTED,
  START: WorkOrderStatus.IN_PROGRESS,
  PAUSE: WorkOrderStatus.PAUSED,
  RESUME: WorkOrderStatus.IN_PROGRESS,
  COMPLETE: WorkOrderStatus.COMPLETED,
  SEND_TO_REWORK: WorkOrderStatus.REWORK,
  CLOSE: WorkOrderStatus.CLOSED,
  CANCEL: WorkOrderStatus.CANCELLED
};

export function nextStatus(current: WorkOrderStatus, action: WorkOrderAction) {
  if (!transitions[action].includes(current)) {
    throw new Error(`Переход ${action} недоступен из статуса ${current}`);
  }
  return targets[action];
}
