// НарядAI API types for frontend clients. Shapes match the live API responses (see docs/FRONTEND.md).
// Dates are ISO 8601 UTC strings; Prisma decimals (hours, quantity) arrive as strings: convert with Number().

export type ISODate = string;
export type DecimalString = string;

export type Role = "MASTER" | "EXECUTOR" | "MANAGER" | "ADMIN";
export type EmployeeStatus = "AVAILABLE" | "BUSY" | "QUEUED" | "OFF_SHIFT";
export type WorkType = "PLANNED" | "EMERGENCY";
export type Priority = "EMERGENCY" | "HIGH" | "NORMAL" | "PLANNED";
export type WorkOrderStatus =
  | "ISSUED" | "ACCEPTED" | "QUEUED" | "REJECTED" | "IN_PROGRESS" | "PAUSED"
  | "COMPLETED" | "AI_REVIEW" | "REWORK" | "CLOSED" | "CANCELLED";
export type WorkOrderAction =
  | "ACCEPT" | "QUEUE" | "REJECT" | "START" | "PAUSE" | "RESUME" | "COMPLETE" | "SEND_TO_REWORK" | "CLOSE" | "CANCEL";
export type AiVerdict = "ACCEPTED" | "ACCEPTED_WITH_COMMENTS" | "REWORK_REQUIRED";
export type PhotoType = "BEFORE" | "AFTER";
export type Language = "ru" | "kk";

export interface ApiErrorBody { error: string; details?: string }

// ---------- auth ----------
/** `phone` in any common notation ("8 701 234 56 78", "+7 (701) 234-56-78"); the server normalizes it to +7XXXXXXXXXX. */
export interface LoginRequest { phone: string; password: string }
export interface LoginResponse { token: string; user: { id: number; fullName: string; phone: string; role: Role; employeeStatus: EmployeeStatus } }
/** POST /api/auth/change-password → 204; wrong currentPassword → 400 (not 401). */
export interface ChangePasswordRequest { currentPassword: string; newPassword: string }
export interface Me {
  /** `login` is an internal/1C identifier, not used to sign in. */
  id: number; login: string; phone: string | null; fullName: string; role: Role; specialty: string | null; grade: number | null;
  brigadeId: number | null; employeeStatus: EmployeeStatus; isOnShift: boolean; language: Language;
}

// ---------- references ----------
export interface Area { id: number; name: string }
export interface Equipment { id: number; name: string; inventoryNumber: string; type: string; criticality: number; qrToken: string; areaId: number }
export interface FaultCode { id: number; code: string; name: string; category: string }
export interface Material { id: number; name: string; unit: string }
export interface Brigade { id: number; name: string; members: Array<{ id: number; fullName: string; specialty: string | null }> }
export interface MaterialNorm { id: number; normativeId: number; materialId: number; quantity: DecimalString; material: Material }
export interface Normative {
  id: number; name: string; equipmentType: string | null; equipmentId: number | null; faultCodeId: number | null;
  hours: DecimalString; faultCode: FaultCode | null; materialNorms: MaterialNorm[];
}
export interface ExecutorRef {
  id: number; fullName: string; specialty: string | null; grade: number | null; employeeStatus: EmployeeStatus;
  isOnShift: boolean; _count: { assignedOrders: number };
}

// ---------- work orders ----------
export interface Photo {
  id: number; workOrderId: number; authorId: number; type: PhotoType;
  /** Signed link: use as-is in <img src={BASE + fileUrl}>, valid 7 days. */
  fileUrl: string;
  capturedAt: ISODate; contentHash: string | null; metadata: Record<string, unknown> | null;
  aiScore: number | null; aiComment: string | null;
}
export interface MaterialUsage { id: number; workOrderId: number; materialId: number; quantity: DecimalString; material: Material }
export interface AiAssessment {
  id: number; workOrderId: number; verdict: AiVerdict; score: number; explanation: string;
  strengths: string[] | null; improvements: string[] | null;
  confidence: number | null; photoScore: number | null; photoComment: string | null;
  masterScore: number | null; masterComment: string | null; reviewedById: number | null;
  /** Internal model output; do not render. */
  rawResponse?: unknown;
  createdAt: ISODate;
}
export interface WorkOrderEvent {
  id: number; workOrderId: number; actorId: number;
  action: WorkOrderAction | "CREATE" | "AI_REVIEW" | "EDIT" | "REASSIGN";
  fromStatus: WorkOrderStatus | null; toStatus: WorkOrderStatus | null; comment: string | null;
  clientActionId: string | null; createdAt: ISODate; actor: { id: number; fullName: string };
}
export interface WorkOrderBase {
  id: number; number: string; type: WorkType; description: string; priority: Priority; deadline: ISODate;
  status: WorkOrderStatus; comment: string | null; completionText: string | null;
  pauseReason: string | null; rejectionReason: string | null;
  createdAt: ISODate; updatedAt: ISODate; acceptedAt: ISODate | null; startedAt: ISODate | null;
  completedAt: ISODate | null; closedAt: ISODate | null;
  areaId: number; equipmentId: number; creatorId: number; assigneeId: number;
  faultCodeId: number | null; normativeId: number | null; actualDowntimeMinutes: number | null;
  area: Area; equipment: Equipment;
  assignee: { id: number; fullName: string; specialty: string | null; employeeStatus: EmployeeStatus };
  faultCode: FaultCode | null;
}
/** GET /api/work-orders?compact=1 */
export interface WorkOrderCompact extends WorkOrderBase {
  aiAssessment: Pick<AiAssessment, "verdict" | "score" | "masterScore"> | null;
}
/** GET /api/work-orders (full), POST responses, Socket.IO work-order:changed */
export interface WorkOrder extends WorkOrderBase {
  creator: { id: number; fullName: string };
  photos: Photo[];
  materialUsages: MaterialUsage[];
  aiAssessment: AiAssessment | null;
}
/** GET /api/work-orders/:id */
export interface WorkOrderDetail extends WorkOrder { events: WorkOrderEvent[] }

export interface WorkOrderListQuery {
  status?: WorkOrderStatus[]; areaId?: number; assigneeId?: number;
  limit?: number; offset?: number; compact?: boolean;
}
export interface CreateWorkOrderRequest {
  type: WorkType; description: string; areaId: number; equipmentId: number; assigneeId: number; priority: Priority;
  /** Either deadline or normativeId is required. */
  deadline?: ISODate; normativeId?: number; comment?: string;
  /** Up to 5 URLs from POST /api/uploads. */
  beforePhotoUrls?: string[];
}
export interface UpdateWorkOrderRequest { priority?: Priority; deadline?: ISODate; comment?: string }
export interface ReassignRequest { assigneeId: number }

export interface ActionRequest {
  action: WorkOrderAction;
  /** Required for REJECT and PAUSE (reason). */
  comment?: string;
  /** 8-100 chars, generate once per offline action and reuse on retries. */
  clientActionId?: string;
  // COMPLETE
  completionText?: string;
  faultCodeId?: number;
  afterPhotoUrls?: string[];
  materials?: Array<{ materialId: number; quantity: number }>;
  // CLOSE
  masterScore?: 1 | 2 | 3 | 4 | 5;
  actualDowntimeMinutes?: number;
}
export interface ActionResponse {
  order: WorkOrder;
  /** Present after COMPLETE. */
  assessment: AiAssessment | null;
  /** true when the server had already applied this clientActionId. */
  replayed?: true;
}

// ---------- files & voice ----------
export interface UploadResponse { url: string; originalName: string; size: number }
export interface TranscribeResponse { text: string }

// ---------- notifications & devices ----------
export type NotificationType =
  | "NEW_ORDER" | "DEADLINE_REMINDER" | "NOT_ACCEPTED" | "WEEKLY_AI_SUMMARY"
  | `OVERDUE_${number}` | `LONG_OVERDUE_${number}`;
export interface Notification {
  id: number; userId: number; workOrderId: number | null; type: NotificationType;
  title: string; message: string; isRead: boolean; createdAt: ISODate;
}
export interface RegisterDeviceRequest { token: string; platform: "android" | "ios" | "web" }
/** FCM data payload */
export interface PushData { type: NotificationType; workOrderId?: string; priority?: Priority }

// ---------- equipment ----------
export interface EquipmentWithArea extends Equipment { area: Area }
/** GET /api/equipment/:id/history returns `EquipmentHistory | null` (null for an unknown id). */
export interface EquipmentHistory extends EquipmentWithArea {
  orders: Array<WorkOrderBase & {
    faultCode: FaultCode | null; aiAssessment: AiAssessment | null;
    downtime: { id: number; startedAt: ISODate; endedAt: ISODate | null; reason: string | null } | null;
    materialUsages: MaterialUsage[];
  }>;
}

// ---------- recommendations & assistant ----------
export interface ExecutorRecommendation {
  id: number; fullName: string; specialty: string | null; employeeStatus: EmployeeStatus;
  queue: number; equipmentRating: number; score: number;
}
export interface WorkRecommendationRequest { description: string; equipmentId: number }
export interface WorkRecommendation { faultCodeId: number | null; normativeId: number | null; estimatedHours: number; explanation: string }

export type AssistantIntentName = "FREE_EXECUTORS" | "OVERDUE" | "EQUIPMENT_HISTORY" | "SHIFT_REPORT" | "ANOMALIES" | "FAILURE_FORECAST";
export interface AssistantResponse {
  answer: string;
  intent: { intent: AssistantIntentName; specialty?: string; equipmentQuery?: string; equipmentId?: number };
  data: unknown;
}
export interface AssistantMessage { id: number; userId: number; role: "user" | "assistant"; content: string; sources: unknown; createdAt: ISODate }

// ---------- analytics & reports ----------
export interface Dashboard {
  active: number; overdue: number; equipmentInDowntime: number;
  averageReactionMinutes: number; averageCompletionMinutes: number;
  topEquipment: Array<{ equipmentId: number; name?: string; _count: number }>;
  topExecutors: Array<{ id: number; fullName: string; score: number; closed: number }>;
}
export interface FailureForecastItem { equipmentId: number; equipment: string; recentFailures: number; previousFailures: number; growth: number; probability: number }
export type AnomalyType = "FREQUENT_FAILURES" | "REPEATED_FAULT" | "FAILURE_AFTER_PLANNED_MAINTENANCE" | "MATERIAL_ANOMALY";
export interface Anomaly {
  id: number; type: AnomalyType; title: string; description: string; recommendation: string; severity: number;
  areaId: number | null; equipmentId: number | null; periodFrom: ISODate; periodTo: ISODate;
  evidence: Record<string, unknown>; createdAt: ISODate; area: Area | null; equipment: Equipment | null;
}
/** Fresh insights come without the area/equipment relations. */
export interface AnomalyRunResponse { insights: Array<Omit<Anomaly, "area" | "equipment">>; ai: { summary: string; recommendations: string[] } }
export interface ShiftReport { from: ISODate; issued: number; completed: number; closed: number; overdue: number; aiSummary: string }
export interface ExecutorRating {
  id: number; fullName: string; score: number; quality: number; onTimeRate: number; reworkRate: number;
  productivity: number; unjustifiedRejects: number; complexityBonus: number; closed: number; explanation: string;
}
export interface BrigadeRating { id: number; name: string; closed: number; quality: number; onTimeRate: number; score: number }
export interface MaterialReportItem { materialId: number; _sum: { quantity: DecimalString | null }; _count: number; material: Material }
export interface DowntimeReportItem {
  id: number; equipmentId: number; workOrderId: number; startedAt: ISODate; endedAt: ISODate | null; reason: string | null;
  /** Up to now for open downtime. */
  minutes: number;
  equipment: EquipmentWithArea;
  workOrder: Omit<WorkOrderBase, "area" | "equipment" | "assignee" | "faultCode"> & { faultCode: FaultCode | null };
}
/** GET /api/reports/work-order/:id; null when the order does not exist. */
export type WorkOrderPrintCard = (Omit<WorkOrderBase, "assignee" | "faultCode"> & {
  creator: { fullName: string }; assignee: { fullName: string };
  events: Omit<WorkOrderEvent, "actor">[]; photos: Photo[]; materialUsages: MaterialUsage[]; aiAssessment: AiAssessment | null;
}) | null;
/** shift, export.xlsx, export.pdf accept all fields; ratings, brigade-ratings, downtime only `from`; materials `from` and `areaId`. */
export interface ReportFilters { from?: ISODate; to?: ISODate; areaId?: number; equipmentId?: number; executorId?: number; brigadeId?: number }

// ---------- admin ----------
export interface CreateUserRequest {
  phone: string; /** 6–128 chars */ password: string; fullName: string; role: Role;
  specialty?: string; grade?: number; brigadeId?: number; language?: Language;
  /** Defaults to the normalized phone. */
  login?: string;
}
/** PATCH /api/admin/users/:id — edit an employee or reset the password. */
export type UpdateUserRequest = Partial<Omit<CreateUserRequest, "login" | "brigadeId">> & { brigadeId?: number | null };
export interface ShiftUpdateRequest { isOnShift: boolean; employeeStatus: EmployeeStatus }
export interface AdminUser extends Me { brigade: { id: number; name: string } | null }
export interface AreaRequest { name: string }
export interface CreateEquipmentRequest { name: string; inventoryNumber: string; type: string; criticality: 1 | 2 | 3 | 4 | 5; areaId: number }
export type UpdateEquipmentRequest = Partial<CreateEquipmentRequest>;
export interface CreateFaultCodeRequest { code: string; name: string; category: string }
export interface CreateMaterialRequest { name: string; unit: string }
export interface CreateBrigadeRequest { name: string }
export interface CreateNormativeRequest {
  name: string; equipmentType?: string; equipmentId?: number; faultCodeId?: number; hours: number;
  materials?: Array<{ materialId: number; quantity: number }>;
}
export type AdminResource = "areas" | "equipment" | "fault-codes" | "materials" | "brigades" | "normatives";

// ---------- 1C integration panel (ADMIN, MANAGER) ----------
export type IntegrationEntity = "AREA" | "EQUIPMENT" | "BRIGADE" | "EMPLOYEE" | "FAULT_CODE" | "MATERIAL" | "NORMATIVE" | "WORK_ORDER";
export type IntegrationStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "DEAD";
export interface IntegrationJob {
  id: number; direction: "INBOUND" | "OUTBOUND"; entity: IntegrationEntity; eventType: string;
  localId: number | null; externalId: string | null; idempotencyKey: string; payload: unknown;
  status: IntegrationStatus; attempts: number; nextAttemptAt: ISODate; lastAttemptAt: ISODate | null;
  completedAt: ISODate | null; lastError: string | null; response: unknown; createdAt: ISODate; updatedAt: ISODate;
}
export interface IntegrationMapping { id: number; entity: IntegrationEntity; localId: number; externalId: string; createdAt: ISODate; updatedAt: ISODate }
export interface OneCRunResponse { processed: number; succeeded?: number; disabled: boolean }
export interface PushOrdersRequest { ids?: number[]; since?: ISODate }
export interface PushOrdersResponse { queued: number; jobIds: number[] }

// ---------- Socket.IO ----------
export interface ServerToClientEvents {
  "work-order:changed": (order: WorkOrder) => void;
  "notification:new": (notification: Notification) => void;
}
