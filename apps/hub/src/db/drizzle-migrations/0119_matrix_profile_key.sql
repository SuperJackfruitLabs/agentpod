-- Item 9 step 3: the Matrix profile the bridge last applied, so a changed persona refreshes it.
ALTER TABLE "stations" ADD COLUMN "matrix_profile_key" text;
