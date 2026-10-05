-- CreateTable
CREATE TABLE `Area` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `Area_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Equipment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `inventoryNumber` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `criticality` INTEGER NOT NULL DEFAULT 1,
    `qrToken` VARCHAR(191) NOT NULL,
    `areaId` INTEGER NOT NULL,

    UNIQUE INDEX `Equipment_inventoryNumber_key`(`inventoryNumber`),
    UNIQUE INDEX `Equipment_qrToken_key`(`qrToken`),
    INDEX `Equipment_areaId_idx`(`areaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Brigade` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `Brigade_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `User` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `login` VARCHAR(191) NOT NULL,
    `pinHash` VARCHAR(191) NOT NULL,
    `fullName` VARCHAR(191) NOT NULL,
    `role` ENUM('MASTER', 'EXECUTOR', 'MANAGER', 'ADMIN') NOT NULL,
    `specialty` VARCHAR(191) NULL,
    `grade` INTEGER NULL,
    `brigadeId` INTEGER NULL,
    `employeeStatus` ENUM('AVAILABLE', 'BUSY', 'QUEUED', 'OFF_SHIFT') NOT NULL DEFAULT 'OFF_SHIFT',
    `isOnShift` BOOLEAN NOT NULL DEFAULT false,
    `language` VARCHAR(191) NOT NULL DEFAULT 'ru',

    UNIQUE INDEX `User_login_key`(`login`),
    INDEX `User_role_employeeStatus_idx`(`role`, `employeeStatus`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FaultCode` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `category` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `FaultCode_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Material` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `unit` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `Material_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkNormative` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `equipmentType` VARCHAR(191) NULL,
    `equipmentId` INTEGER NULL,
    `faultCodeId` INTEGER NULL,
    `hours` DECIMAL(8, 2) NOT NULL,

    INDEX `WorkNormative_equipmentType_faultCodeId_idx`(`equipmentType`, `faultCodeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MaterialNorm` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `normativeId` INTEGER NOT NULL,
    `materialId` INTEGER NOT NULL,
    `quantity` DECIMAL(10, 2) NOT NULL,

    UNIQUE INDEX `MaterialNorm_normativeId_materialId_key`(`normativeId`, `materialId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkOrder` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `number` VARCHAR(191) NOT NULL,
    `type` ENUM('PLANNED', 'EMERGENCY') NOT NULL,
    `description` TEXT NOT NULL,
    `priority` ENUM('EMERGENCY', 'HIGH', 'NORMAL', 'PLANNED') NOT NULL,
    `deadline` DATETIME(3) NOT NULL,
    `status` ENUM('ISSUED', 'ACCEPTED', 'QUEUED', 'REJECTED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'AI_REVIEW', 'REWORK', 'CLOSED', 'CANCELLED') NOT NULL DEFAULT 'ISSUED',
    `comment` TEXT NULL,
    `completionText` TEXT NULL,
    `pauseReason` VARCHAR(191) NULL,
    `rejectionReason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `acceptedAt` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `areaId` INTEGER NOT NULL,
    `equipmentId` INTEGER NOT NULL,
    `creatorId` INTEGER NOT NULL,
    `assigneeId` INTEGER NOT NULL,
    `faultCodeId` INTEGER NULL,
    `normativeId` INTEGER NULL,
    `actualDowntimeMinutes` INTEGER NULL,

    UNIQUE INDEX `WorkOrder_number_key`(`number`),
    INDEX `WorkOrder_status_deadline_idx`(`status`, `deadline`),
    INDEX `WorkOrder_assigneeId_status_idx`(`assigneeId`, `status`),
    INDEX `WorkOrder_equipmentId_createdAt_idx`(`equipmentId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkOrderEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workOrderId` INTEGER NOT NULL,
    `actorId` INTEGER NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `fromStatus` ENUM('ISSUED', 'ACCEPTED', 'QUEUED', 'REJECTED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'AI_REVIEW', 'REWORK', 'CLOSED', 'CANCELLED') NULL,
    `toStatus` ENUM('ISSUED', 'ACCEPTED', 'QUEUED', 'REJECTED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'AI_REVIEW', 'REWORK', 'CLOSED', 'CANCELLED') NULL,
    `comment` TEXT NULL,
    `clientActionId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `WorkOrderEvent_clientActionId_key`(`clientActionId`),
    INDEX `WorkOrderEvent_workOrderId_createdAt_idx`(`workOrderId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Photo` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workOrderId` INTEGER NOT NULL,
    `authorId` INTEGER NOT NULL,
    `type` ENUM('BEFORE', 'AFTER') NOT NULL,
    `fileUrl` VARCHAR(191) NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `contentHash` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `aiScore` INTEGER NULL,
    `aiComment` TEXT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MaterialUsage` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workOrderId` INTEGER NOT NULL,
    `materialId` INTEGER NOT NULL,
    `quantity` DECIMAL(10, 2) NOT NULL,

    UNIQUE INDEX `MaterialUsage_workOrderId_materialId_key`(`workOrderId`, `materialId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiAssessment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `workOrderId` INTEGER NOT NULL,
    `verdict` ENUM('ACCEPTED', 'ACCEPTED_WITH_COMMENTS', 'REWORK_REQUIRED') NOT NULL,
    `score` INTEGER NOT NULL,
    `explanation` TEXT NOT NULL,
    `strengths` JSON NULL,
    `improvements` JSON NULL,
    `rawResponse` JSON NULL,
    `confidence` DOUBLE NULL,
    `photoScore` INTEGER NULL,
    `photoComment` TEXT NULL,
    `masterScore` INTEGER NULL,
    `masterComment` TEXT NULL,
    `reviewedById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AiAssessment_workOrderId_key`(`workOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `workOrderId` INTEGER NULL,
    `type` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `message` TEXT NOT NULL,
    `isRead` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Notification_userId_isRead_createdAt_idx`(`userId`, `isRead`, `createdAt`),
    INDEX `Notification_workOrderId_type_idx`(`workOrderId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PushDevice` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `token` VARCHAR(512) NOT NULL,
    `platform` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PushDevice_token_key`(`token`),
    INDEX `PushDevice_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EquipmentDowntime` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `equipmentId` INTEGER NOT NULL,
    `workOrderId` INTEGER NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NULL,
    `reason` VARCHAR(191) NULL,

    UNIQUE INDEX `EquipmentDowntime_workOrderId_key`(`workOrderId`),
    INDEX `EquipmentDowntime_equipmentId_startedAt_idx`(`equipmentId`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AnomalyInsight` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `type` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NOT NULL,
    `recommendation` TEXT NOT NULL,
    `severity` INTEGER NOT NULL,
    `areaId` INTEGER NULL,
    `equipmentId` INTEGER NULL,
    `periodFrom` DATETIME(3) NOT NULL,
    `periodTo` DATETIME(3) NOT NULL,
    `evidence` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AnomalyInsight_createdAt_severity_idx`(`createdAt`, `severity`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AssistantMessage` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `sources` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AssistantMessage_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Equipment` ADD CONSTRAINT `Equipment_areaId_fkey` FOREIGN KEY (`areaId`) REFERENCES `Area`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_brigadeId_fkey` FOREIGN KEY (`brigadeId`) REFERENCES `Brigade`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkNormative` ADD CONSTRAINT `WorkNormative_equipmentId_fkey` FOREIGN KEY (`equipmentId`) REFERENCES `Equipment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkNormative` ADD CONSTRAINT `WorkNormative_faultCodeId_fkey` FOREIGN KEY (`faultCodeId`) REFERENCES `FaultCode`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MaterialNorm` ADD CONSTRAINT `MaterialNorm_normativeId_fkey` FOREIGN KEY (`normativeId`) REFERENCES `WorkNormative`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MaterialNorm` ADD CONSTRAINT `MaterialNorm_materialId_fkey` FOREIGN KEY (`materialId`) REFERENCES `Material`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkOrder` ADD CONSTRAINT `WorkOrder_areaId_fkey` FOREIGN KEY (`areaId`) REFERENCES `Area`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkOrder` ADD CONSTRAINT `WorkOrder_equipmentId_fkey` FOREIGN KEY (`equipmentId`) REFERENCES `Equipment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkOrder` ADD CONSTRAINT `WorkOrder_creatorId_fkey` FOREIGN KEY (`creatorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkOrder` ADD CONSTRAINT `WorkOrder_assigneeId_fkey` FOREIGN KEY (`assigneeId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkOrder` ADD CONSTRAINT `WorkOrder_faultCodeId_fkey` FOREIGN KEY (`faultCodeId`) REFERENCES `FaultCode`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkOrder` ADD CONSTRAINT `WorkOrder_normativeId_fkey` FOREIGN KEY (`normativeId`) REFERENCES `WorkNormative`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkOrderEvent` ADD CONSTRAINT `WorkOrderEvent_workOrderId_fkey` FOREIGN KEY (`workOrderId`) REFERENCES `WorkOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkOrderEvent` ADD CONSTRAINT `WorkOrderEvent_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Photo` ADD CONSTRAINT `Photo_workOrderId_fkey` FOREIGN KEY (`workOrderId`) REFERENCES `WorkOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Photo` ADD CONSTRAINT `Photo_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MaterialUsage` ADD CONSTRAINT `MaterialUsage_workOrderId_fkey` FOREIGN KEY (`workOrderId`) REFERENCES `WorkOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MaterialUsage` ADD CONSTRAINT `MaterialUsage_materialId_fkey` FOREIGN KEY (`materialId`) REFERENCES `Material`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiAssessment` ADD CONSTRAINT `AiAssessment_workOrderId_fkey` FOREIGN KEY (`workOrderId`) REFERENCES `WorkOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiAssessment` ADD CONSTRAINT `AiAssessment_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_workOrderId_fkey` FOREIGN KEY (`workOrderId`) REFERENCES `WorkOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PushDevice` ADD CONSTRAINT `PushDevice_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EquipmentDowntime` ADD CONSTRAINT `EquipmentDowntime_equipmentId_fkey` FOREIGN KEY (`equipmentId`) REFERENCES `Equipment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EquipmentDowntime` ADD CONSTRAINT `EquipmentDowntime_workOrderId_fkey` FOREIGN KEY (`workOrderId`) REFERENCES `WorkOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AnomalyInsight` ADD CONSTRAINT `AnomalyInsight_areaId_fkey` FOREIGN KEY (`areaId`) REFERENCES `Area`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AnomalyInsight` ADD CONSTRAINT `AnomalyInsight_equipmentId_fkey` FOREIGN KEY (`equipmentId`) REFERENCES `Equipment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AssistantMessage` ADD CONSTRAINT `AssistantMessage_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
