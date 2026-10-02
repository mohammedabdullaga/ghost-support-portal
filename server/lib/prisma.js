import { PrismaClient } from '@prisma/client';

// Single shared PrismaClient instance for the whole process.
export const prisma = new PrismaClient();
