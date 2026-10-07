import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { reindexKnowledge } from "../src/services/rag.js";

console.log(await reindexKnowledge());
await prisma.$disconnect();
