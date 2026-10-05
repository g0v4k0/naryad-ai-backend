-- AlterTable
ALTER TABLE `WorkOrder` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- CreateTable
CREATE TABLE `IntegrationMapping` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `entity` ENUM('AREA', 'EQUIPMENT', 'BRIGADE', 'EMPLOYEE', 'FAULT_CODE', 'MATERIAL', 'NORMATIVE', 'WORK_ORDER') NOT NULL,
    `localId` INTEGER NOT NULL,
    `externalId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `IntegrationMapping_entity_localId_key`(`entity`, `localId`),
    UNIQUE INDEX `IntegrationMapping_entity_externalId_key`(`entity`, `externalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `IntegrationJob` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `direction` ENUM('INBOUND', 'OUTBOUND') NOT NULL,
    `entity` ENUM('AREA', 'EQUIPMENT', 'BRIGADE', 'EMPLOYEE', 'FAULT_CODE', 'MATERIAL', 'NORMATIVE', 'WORK_ORDER') NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `localId` INTEGER NULL,
    `externalId` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'DEAD') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastAttemptAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `response` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `IntegrationJob_idempotencyKey_key`(`idempotencyKey`),
    INDEX `IntegrationJob_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `IntegrationJob_entity_localId_createdAt_idx`(`entity`, `localId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

