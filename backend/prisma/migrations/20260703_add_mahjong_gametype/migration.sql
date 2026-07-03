-- 新增麻將聽牌挑戰（第三類「麻將」單人先行版）的 GameType 列舉值。
-- 純新增列舉值，不影響既有資料列、不需要重寫資料表。
ALTER TYPE "GameType" ADD VALUE 'MAHJONG';
