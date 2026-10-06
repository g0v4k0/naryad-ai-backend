-- Sign-in moves from login + PIN to phone + password. Existing hashes are kept, so a user's old PIN works as the password.
ALTER TABLE `User` RENAME COLUMN `pinHash` TO `passwordHash`;
ALTER TABLE `User` ADD COLUMN `phone` VARCHAR(20) NULL;
CREATE UNIQUE INDEX `User_phone_key` ON `User`(`phone`);
