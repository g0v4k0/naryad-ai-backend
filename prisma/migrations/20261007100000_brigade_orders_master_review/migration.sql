-- Orders can be issued to a brigade; AI assessments flag low-confidence cases for the master.
ALTER TABLE `WorkOrder` ADD COLUMN `brigadeId` INTEGER NULL;
CREATE INDEX `WorkOrder_brigadeId_idx` ON `WorkOrder`(`brigadeId`);
ALTER TABLE `WorkOrder` ADD CONSTRAINT `WorkOrder_brigadeId_fkey` FOREIGN KEY (`brigadeId`) REFERENCES `Brigade`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `AiAssessment` ADD COLUMN `needsMasterReview` BOOLEAN NOT NULL DEFAULT false;
