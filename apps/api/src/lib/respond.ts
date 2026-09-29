import type { Response } from "express";
import type { ApiFailure, ApiSuccess } from "@household/shared";
import type { AppError } from "./errors.js";

export function ok<T>(res: Response, data: T, status = 200, message: string | null = null): void {
  const body: ApiSuccess<T> = { success: true, data, message };
  res.status(status).json(body);
}

export function fail(res: Response, err: AppError): void {
  const body: ApiFailure = { success: false, error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } };
  res.status(err.status).json(body);
}
