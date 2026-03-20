import { getAccessToken, getMatrixContext } from "./server-helpers.js";

describe("getAccessToken", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MATRIX_ACCESS_TOKEN;
    delete process.env.ENABLE_OAUTH;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns matrix_access_token from headers when present as string", () => {
    const headers = { matrix_access_token: "tok_header" };
    expect(getAccessToken(headers, "tok_oauth")).toBe("tok_header");
  });

  it("returns first non-empty string when header is an array", () => {
    const headers = { matrix_access_token: ["", "tok_array"] };
    expect(getAccessToken(headers, undefined)).toBe("tok_array");
  });

  it("skips empty string header values", () => {
    const headers = { matrix_access_token: "" };
    process.env.MATRIX_ACCESS_TOKEN = "tok_env";
    expect(getAccessToken(headers, undefined)).toBe("tok_env");
  });

  it("falls back to env MATRIX_ACCESS_TOKEN when no header or oauth", () => {
    process.env.MATRIX_ACCESS_TOKEN = "tok_env";
    expect(getAccessToken({}, undefined)).toBe("tok_env");
  });

  it("returns empty string when nothing is available", () => {
    expect(getAccessToken({}, undefined)).toBe("");
  });

  it("returns empty string when headers are undefined", () => {
    expect(getAccessToken(undefined, undefined)).toBe("");
  });

  it("header takes priority over oauth token", () => {
    const headers = { matrix_access_token: "tok_header" };
    expect(getAccessToken(headers, "tok_oauth")).toBe("tok_header");
  });

  it("header takes priority over env var", () => {
    process.env.MATRIX_ACCESS_TOKEN = "tok_env";
    const headers = { matrix_access_token: "tok_header" };
    expect(getAccessToken(headers, undefined)).toBe("tok_header");
  });
});

describe("getMatrixContext", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MATRIX_USER_ID;
    delete process.env.MATRIX_HOMESERVER_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("extracts matrixUserId from header string", () => {
    const headers = { matrix_user_id: "@alice:example.com" };
    const { matrixUserId } = getMatrixContext(headers);
    expect(matrixUserId).toBe("@alice:example.com");
  });

  it("extracts matrixUserId from header array (first element)", () => {
    const headers = { matrix_user_id: ["@alice:example.com", "@bob:example.com"] };
    const { matrixUserId } = getMatrixContext(headers);
    expect(matrixUserId).toBe("@alice:example.com");
  });

  it("falls back to MATRIX_USER_ID env var", () => {
    process.env.MATRIX_USER_ID = "@env:example.com";
    const { matrixUserId } = getMatrixContext({});
    expect(matrixUserId).toBe("@env:example.com");
  });

  it("returns empty string when no user id available", () => {
    const { matrixUserId } = getMatrixContext({});
    expect(matrixUserId).toBe("");
  });

  it("extracts homeserverUrl from header", () => {
    const headers = { matrix_homeserver_url: "https://matrix.example.com" };
    const { homeserverUrl } = getMatrixContext(headers);
    expect(homeserverUrl).toBe("https://matrix.example.com");
  });

  it("falls back to default homeserver url", () => {
    const { homeserverUrl } = getMatrixContext({});
    expect(homeserverUrl).toMatch(/^https?:\/\//);
  });

  it("handles undefined headers", () => {
    const result = getMatrixContext(undefined);
    expect(result).toHaveProperty("matrixUserId");
    expect(result).toHaveProperty("homeserverUrl");
  });
});
