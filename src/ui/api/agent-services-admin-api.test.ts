/**
 * A key the key store couldn't save keeps the server's reason (what AWS
 * refused, what to fix) instead of the generic server-error message.
 */
import { describe, it, expect, vi } from "vitest";
import { AxiosError, type AxiosResponse } from "axios";

const put = vi.hoisted(() => vi.fn());
vi.mock("@/main-axios", () => ({
  authApi: { put, delete: put },
  handleApiError: (_e: unknown, op: string) => {
    throw new Error(`generic failure: ${op}`);
  },
}));

import { removeServiceKey, setServiceKey } from "./agent-services-admin-api";

const failWith = (status: number, error: string) =>
  new AxiosError("Request failed", "ERR_BAD_RESPONSE", undefined, undefined, {
    status,
    data: { error },
  } as AxiosResponse);

describe("key changes the key store refused", () => {
  it("keep the server's reason for 424 and 503", async () => {
    put.mockRejectedValueOnce(failWith(424, "AWS refused to save the key: needs ssm:PutParameter"));
    await expect(setServiceKey("image-gen", "OPENAI_API_KEY", "x")).rejects.toThrow("needs ssm:PutParameter");
    put.mockRejectedValueOnce(failWith(503, "Couldn't remove the key: couldn't reach AWS Parameter Store"));
    await expect(removeServiceKey("image-gen", "OPENAI_API_KEY")).rejects.toThrow("couldn't reach AWS Parameter Store");
  });

  it("anything else goes through the shared handler", async () => {
    put.mockRejectedValueOnce(failWith(500, "Failed to save the key"));
    await expect(setServiceKey("image-gen", "OPENAI_API_KEY", "x")).rejects.toThrow("generic failure: save key");
  });
});
