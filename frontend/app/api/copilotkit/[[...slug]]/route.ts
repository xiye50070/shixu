import { runtimeHandler } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = runtimeHandler;
export const POST = runtimeHandler;
export const PATCH = runtimeHandler;
export const DELETE = runtimeHandler;
