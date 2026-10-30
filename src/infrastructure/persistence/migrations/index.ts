import { Migration1793210400000 } from './Migration1793210400000.ts';
import { Migration1793214000000 } from './Migration1793214000000.ts';
import { Migration1793217600000 } from './Migration1793217600000.ts';

/** Migrations na ordem de aplicação. O TypeORM ordena pelo timestamp do nome da classe. */
export const MIGRATIONS = [Migration1793210400000, Migration1793214000000, Migration1793217600000];
