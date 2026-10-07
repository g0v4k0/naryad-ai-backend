import type { WorkOrderStatus } from "@prisma/client";

export const STATUS_LABELS: Record<WorkOrderStatus, string> = {
  ISSUED: "выдан",
  ACCEPTED: "принят",
  QUEUED: "в очереди",
  REJECTED: "отклонён",
  IN_PROGRESS: "в работе",
  PAUSED: "приостановлен",
  COMPLETED: "выполнен",
  AI_REVIEW: "на проверке",
  REWORK: "на доработке",
  CLOSED: "закрыт",
  CANCELLED: "отменён"
};

export const PRIORITY_LABELS: Record<string, string> = { EMERGENCY: "аварийный", HIGH: "высокий", NORMAL: "обычный", PLANNED: "плановый" };

/** "Ахметов Ерлан Серикович" → "Ахметов Е." as in the case's sample message. */
export function shortName(fullName: string) {
  const [last, first] = fullName.trim().split(/\s+/);
  return first ? `${last} ${first[0]}.` : last;
}
