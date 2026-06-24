import { describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";

import { shopifyAuthMiddleware } from "./authMiddleware.js";

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    headers: {},
    body: {},
    protocol: "http",
    get: () => "localhost:3334",
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response & {
  statusCode?: number;
  jsonBody?: unknown;
  headers: Record<string, string>;
} {
  const res = {
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
  };
  return res as unknown as Response & {
    statusCode?: number;
    jsonBody?: unknown;
    headers: Record<string, string>;
  };
}

describe("shopifyAuthMiddleware", () => {
  const exempt = [
    { method: "GET-request", req: mockReq({ method: "GET" }) },
    { method: "initialize", req: mockReq({ body: { method: "initialize" } }) },
    { method: "ping", req: mockReq({ body: { method: "ping" } }) },
    { method: "tools/list", req: mockReq({ body: { method: "tools/list" } }) },
    {
      method: "notifications/initialized",
      req: mockReq({ body: { method: "notifications/initialized" } }),
    },
    { method: "empty body", req: mockReq({ body: {} }) },
  ];

  for (const { method, req } of exempt) {
    it(`lets ${method} through without auth`, () => {
      const next = jest.fn() as unknown as NextFunction;
      const res = mockRes();
      shopifyAuthMiddleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBeUndefined();
    });
  }

  it("401s a tools/call without a bearer token", () => {
    const next = jest.fn() as unknown as NextFunction;
    const res = mockRes();
    shopifyAuthMiddleware(
      mockReq({ body: { method: "tools/call" } }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toMatch(/invalid_token/);
    expect((res.jsonBody as { error: string }).error).toBe("invalid_token");
  });

  it("allows a tools/call with a bearer token", () => {
    const next = jest.fn() as unknown as NextFunction;
    const res = mockRes();
    shopifyAuthMiddleware(
      mockReq({
        body: { method: "tools/call" },
        headers: { authorization: "Bearer shpat_token" },
      }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });
});
