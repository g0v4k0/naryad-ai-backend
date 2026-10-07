-- RAG memory: master decisions as labelled precedents for the AI review and fault-code suggestion.
-- AlterTable
ALTER TABLE `AiAssessment` ADD COLUMN `ragPrecedents` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `KnowledgeCase` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `kind` ENUM('REVIEW', 'FAULT') NOT NULL,
    `workOrderId` INTEGER NOT NULL,
    `textHash` CHAR(40) NOT NULL,
    `problem` TEXT NOT NULL,
    `report` TEXT NULL,
    `equipmentType` VARCHAR(191) NOT NULL,
    `model` VARCHAR(191) NOT NULL,
    `embedding` LONGBLOB NOT NULL,
    `accepted` BOOLEAN NULL,
    `aiVerdict` ENUM('ACCEPTED', 'ACCEPTED_WITH_COMMENTS', 'REWORK_REQUIRED') NULL,
    `masterScore` INTEGER NULL,
    `masterComment` TEXT NULL,
    `faultCodeId` INTEGER NULL,
    `normativeId` INTEGER NULL,
    `actualHours` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `KnowledgeCase_kind_updatedAt_idx`(`kind`, `updatedAt`),
    UNIQUE INDEX `KnowledgeCase_kind_workOrderId_textHash_key`(`kind`, `workOrderId`, `textHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `KnowledgeCase` ADD CONSTRAINT `KnowledgeCase_workOrderId_fkey` FOREIGN KEY (`workOrderId`) REFERENCES `WorkOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

