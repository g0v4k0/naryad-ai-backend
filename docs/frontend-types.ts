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
/** GET /api/references/executors[?specialty=&brigadeId=&onShift=1] */
export interface ExecutorRef {
  id: number; fullName: string; specialty: string | null; grade: number | null; employeeStatus: EmployeeStatus;
  isOnShift: boolean; brigadeId: number | null; brigade: { id: number; name: string } | null;
  /** «свободен» / «выполняет наряд №…, в очереди N» / «в очереди N нарядов» / «не на смене» */
  statusText: string;
  currentOrder: { id: number; number: string; status: WorkOrderStatus; priority: Priority; deadline: ISODate; equipment: { name: string } } | null;
  /** Waiting orders (ISSUED, QUEUED). */
  queue: number;
  activeOrders: number;
  _count: { assignedOrders: number };
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
  /** The AI is not sure: show «Нужна проверка мастером», the verdict is only a hint. */
  needsMasterReview: boolean;
  masterScore: number | null; masterComment: string | null; reviewedById: number | null;
  /** Internal model output; do not render. */
  rawResponse?: unknown;
  createdAt: ISODate;
}
export interface WorkOrderEvent {
  id: number; workOrderId: number; actorId: number;
  action: WorkOrderAction | "CREATE" | "AI_REVIEW" | "EDIT" | "REASSIGN" | "COMMENT";
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
  /** Set when the order was issued to a brigade; the assignee leads it. */
  brigadeId: number | null; brigade: { id: number; name: string } | null;
  area: Area; equipment: Equipment;
  assignee: { id: number; fullName: string; specialty: string | null; employeeStatus: EmployeeStatus };
  faultCode: FaultCode | null;
}
/** GET /api/work-orders?compact=1 */
export interface WorkOrderCompact extends WorkOrderBase {
  aiAssessment: Pick<AiAssessment, "verdict" | "score" | "masterScore" | "needsMasterReview"> | null;
  /** Only in list and board responses: deadline passed and the order is still open. */
  isOverdue?: boolean;
}
/** GET /api/work-orders (full), POST responses, Socket.IO work-order:changed */
export interface WorkOrder extends WorkOrderBase {
  creator: { id: number; fullName: string };
  normative: Omit<Normative, "faultCode" | "materialNorms"> | null;
  downtime: { id: number; equipmentId: number; workOrderId: number; startedAt: ISODate; endedAt: ISODate | null; reason: string | null } | null;
  photos: Photo[];
  materialUsages: MaterialUsage[];
  aiAssessment: AiAssessment | null;
}
/** Time against the normative and the deadline. */
export interface OrderTiming {
  normativeHours: number | null; actualHours: number | null; vsNormativePercent: number | null;
  /** null until the order is completed. */
  deadlineMet: boolean | null; overdueMinutes: number;
}
/** GET /api/work-orders/:id */
export interface WorkOrderDetail extends WorkOrder { events: WorkOrderEvent[]; timing: OrderTiming; isOverdue: boolean }

export interface WorkOrderListQuery {
  status?: WorkOrderStatus[]; priority?: Priority[]; type?: WorkType;
  areaId?: number; equipmentId?: number; assigneeId?: number; brigadeId?: number;
  /** Only open orders past the deadline. */
  overdue?: boolean;
  limit?: number; offset?: number; compact?: boolean;
}
/** GET /api/work-orders/board — master's kanban and shift counters. */
export interface WorkOrderBoard {
  since: ISODate;
  counters: { issued: number; completed: number; overdue: number; equipmentInDowntime: number };
  columns: Record<"issued" | "accepted" | "inProgress" | "queued" | "completed" | "overdue", WorkOrderCompact[]>;
}
/** GET /api/work-orders/:id/report as an executor (own order only). */
export interface ExecutorOrderReport {
  audience: "EXECUTOR"; id: number; number: string; equipment: string; status: WorkOrderStatus; assigneeId: number;
  verdict: AiVerdict | null; aiScore: number | null; masterScore: number | null;
  /** Master's score when set, otherwise the AI's. */
  finalScore: number | null;
  explanation: string | null; strengths: string[]; improvements: string[];
  masterComment: string | null; photoComment: string | null; timing: OrderTiming;
}
/** GET /api/work-orders/:id/report as staff; also GET /api/reports/work-order/:id (without `audience`). */
export interface MasterOrderReport extends Omit<WorkOrder, "creator" | "assignee"> {
  audience?: "MASTER";
  creator: { id: number; fullName: string }; assignee: { id: number; fullName: string; specialty: string | null };
  events: WorkOrderEvent[];
  timing: OrderTiming; downtimeMinutes: number | null; finalScore: number | null;
  chronology: Array<{ at: ISODate; action: string; from: WorkOrderStatus | null; to: WorkOrderStatus | null; actor: string; comment: string | null }>;
  photosBefore: Photo[]; photosAfter: Photo[];
}
/** POST /api/work-orders/:id/comment */
export interface CommentRequest { comment: string; clientActionId?: string }

export interface CreateWorkOrderRequest {
  type: WorkType; description: string; areaId: number; equipmentId: number; priority: Priority;
  /** Either assigneeId or brigadeId is required; with brigadeId alone the best member on shift is assigned. */
  assigneeId?: number; brigadeId?: number;
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
/** POST /api/uploads (multipart: file, optional takenAt ISO date when the photo has no EXIF). */
export interface UploadResponse { url: string; originalName: string; size: number; takenAt: ISODate | null }
export interface TranscribeResponse { text: string }

// ---------- notifications & devices ----------
export type NotificationType =
  | "NEW_ORDER" | "BRIGADE_ORDER" | "DEADLINE_REMINDER" | "NOT_ACCEPTED" | "WEEKLY_AI_SUMMARY"
  | `OVERDUE_${number}` | `LONG_OVERDUE_${number}`;
export interface Notification {
  id: number; userId: number; workOrderId: number | null; type: NotificationType;
  title: string; message: string; isRead: boolean; createdAt: ISODate;
}
export interface RegisterDeviceRequest { token: string; platform: "android" | "ios" | "web" }
/** FCM data payload */
export interface PushData {
  type: NotificationType; workOrderId?: string; priority?: Priority;
  /** NOT_ACCEPTED: the executor suggested for reassignment. */
  suggestedExecutorId?: string;
}

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
/** GET /api/recommendations/executors?equipmentId=&description=&faultCodeId=&specialty=&brigadeId= */
export interface ExecutorRecommendation {
  id: number; fullName: string; specialty: string | null; brigadeId: number | null; employeeStatus: EmployeeStatus;
  queue: number; equipmentRating: number; score: number;
  /** null when no hint about the job was given. */
  specialtyMatch: boolean | null; requiredSpecialty: string | null;
}
export interface WorkRecommendationRequest { description: string; equipmentId: number }
export interface WorkRecommendation { faultCodeId: number | null; normativeId: number | null; estimatedHours: number; explanation: string }

export type AssistantIntentName = "FREE_EXECUTORS" | "OVERDUE" | "EQUIPMENT_HISTORY" | "SHIFT_REPORT" | "ANOMALIES" | "FAILURE_FORECAST";
export interface AssistantResponse {
  answer: string;
  intent: {
    intent: AssistantIntentName; specialty?: string; equipmentQuery?: string; equipmentId?: number;
    /** Period named in the question, days: shift 0.5, day 1, week 7, month 30, quarter 90. */
    periodDays?: number; areaQuery?: string; areaId?: number; area?: string;
  };
  /** Language of the answer, same as the question. */
  lang: "ru" | "kk";
  /** false: exact template answer (model unavailable or its answer failed the checks). */
  fromModel: boolean;
  data: unknown;
}
export interface AssistantMessage { id: number; userId: number; role: "user" | "assistant"; content: string; sources: unknown; createdAt: ISODate }

// ---------- analytics & reports ----------
export interface Dashboard {
  active: number; overdue: number; equipmentInDowntime: number;
  averageReactionMinutes: number; averageCompletionMinutes: number;
  topEquipment: Array<{ equipmentId: number; name?: string; _count: number }>;
  /** Areas by emergencies per equipment unit, last 30 days. */
  topAreas: AreaStats[];
  topExecutors: Array<{ id: number; fullName: string; score: number; closed: number }>;
}
export interface FailureForecastItem { equipmentId: number; equipment: string; recentFailures: number; previousFailures: number; growth: number; probability: number }
export interface AreaStats { areaId: number; name: string; units: number; emergencies: number; emergenciesPerUnit: number; downtime: number; downtimePerUnit: number; orders: number }
export type AnomalyType =
  | "FREQUENT_FAILURES" | "REPEATED_FAULT" | "FAILURE_AFTER_PLANNED_MAINTENANCE" | "MATERIAL_ANOMALY"
  | "AREA_HOTSPOT" | "SHIFT_PATTERN" | "TIME_OF_DAY" | "EXECUTOR_REPEAT_FAILURES" | "BRIGADE_REPEAT_FAILURES";
export interface Anomaly {
  id: number; type: AnomalyType; title: string; description: string; recommendation: string; severity: number;
  areaId: number | null; equipmentId: number | null; periodFrom: ISODate; periodTo: ISODate;
  evidence: Record<string, unknown>; createdAt: ISODate; area: Area | null; equipment: Equipment | null;
}
/** Fresh insights come without the area/equipment relations. */
export interface AnomalyRunResponse { insights: Array<Omit<Anomaly, "area" | "equipment">>; ai: { summary: string; recommendations: string[] } }
export interface ShiftReport {
  from: ISODate; to: ISODate;
  issued: number; completed: number; closed: number; overdue: number; rejected: number; cancelled: number; inProgress: number;
  load: Array<{ id: number; fullName: string; specialty: string | null; employeeStatus: EmployeeStatus; isOnShift: boolean; assigned: number; completed: number; activeNow: number }>;
  workload: { executorsOnShift: number; busy: number; free: number };
  downtime: { equipmentInDowntimeNow: number; orders: number; minutes: number };
  aiSummary: string;
}
/** GET /api/reports/ratings, /api/reports/my-rating (one item). */
export interface ExecutorRating {
  id: number; fullName: string; specialty: string | null; brigadeId: number | null;
  score: number; quality: number; onTimeRate: number;
  /** Sent back for rework by the master or the AI. */
  reworkRate: number;
  /** The same fault on the same equipment came back within 7 days. */
  repeatFailureRate: number;
  /** Rework or repeat failure, each order counted once; this is what the formula uses. */
  returnRate: number;
  productivity: number; unjustifiedRejects: number; complexityBonus: number; closed: number;
  points: { quality: number; onTime: number; noReturns: number; volume: number; complexity: number; rejects: number };
  /** Plain-language explanation for the executor. */
  explanation: string;
  formula: string;
}
export interface BrigadeRating { id: number; name: string; members: number; closed: number; quality: number; onTimeRate: number; repeatFailureRate: number; score: number }
/** GET /api/reports/materials[?groupBy=material|area|equipment|executor] */
export interface MaterialReportItem {
  group: { id: number; name: string } | null;
  materialId: number; material: Material; unit: string;
  quantity: number; count: number;
  /** Sum of the normatives for lines that have one; deviationPercent compares only those lines. */
  normQuantity: number; deviationPercent: number | null;
  /** Lines above 150% of the norm, with order numbers. */
  overNormCount: number; overNormOrders: string[];
  /** Kept from the previous response format. */
  _sum: { quantity: string }; _count: number;
}
export interface DowntimeReport {
  from: ISODate; to: ISODate;
  totals: { minutes: number; plannedMinutes: number; unplannedMinutes: number; plannedShare: number; unplannedShare: number; ongoing: number };
  byEquipment: Array<{
    equipmentId: number; equipment: string; area: string; minutes: number; count: number;
    plannedMinutes: number; unplannedMinutes: number; plannedShare: number; unplannedShare: number; ongoing: boolean;
    byFaultCode: Array<{ code: string; name: string | null; minutes: number; count: number }>;
  }>;
  items: Array<{
    workOrderId: number; number: string; type: WorkType; equipmentId: number; equipment: string; area: string;
    faultCode: string | null; faultName: string | null; reason: string; startedAt: ISODate | null; endedAt: ISODate | null;
    ongoing: boolean; minutes: number;
  }>;
}
/** All reports and exports. `from` wins over `period`. */
export interface ReportFilters {
  period?: "shift" | "day" | "week" | "month";
  from?: ISODate; to?: ISODate; areaId?: number; equipmentId?: number; executorId?: number; brigadeId?: number;
}
/** GET /api/reports/export.xlsx | export.pdf */
export interface ExportQuery extends ReportFilters {
  report?: "orders" | "shift" | "ratings" | "brigades" | "materials" | "downtime" | "anomalies";
  groupBy?: "material" | "area" | "equipment" | "executor";
}

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
