-- A board whose chat has moved out of this hub (BOARD_CHAT_MOVED_BOARDS) is told so once in its old
-- room: claimed here before the notice is sent, and given back when the send fails (`moved-boards.ts`).
ALTER TABLE "matrix_board_rooms" ADD COLUMN IF NOT EXISTS "moved_notice_at" timestamp;
