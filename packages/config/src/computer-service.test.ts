import { describe, expect, test } from "vitest";
import { ConfigError, loadComputerServiceConfig, type Env } from "./index.ts";

function problems(env: Env): readonly string[] {
  try {
    loadComputerServiceConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected loadComputerServiceConfig to refuse this environment");
}

const key = "k".repeat(32);

describe("the Computer service's settings", () => {
  test("it refuses to start without the key the Bot service presents", () => {
    expect(problems({})).toEqual([expect.stringMatching(/^COMPUTER_SERVICE_API_KEY is required/)]);
    expect(problems({ COMPUTER_SERVICE_API_KEY: "short" })).toEqual([
      expect.stringMatching(/^COMPUTER_SERVICE_API_KEY must be at least 32 characters/),
    ]);
  });

  test("by default it listens on 3100 and runs Computers in local Docker from the Computer image", () => {
    const config = loadComputerServiceConfig({ COMPUTER_SERVICE_API_KEY: key });

    expect(config).toMatchObject({
      apiKey: key,
      port: 3100,
      backend: "docker",
      docker: { host: null, image: "kovobot-computer", network: null },
    });
  });

  test("it listens on COMPUTER_SERVICE_URL's port, and runs Computers on the Docker network and image it is given", () => {
    const config = loadComputerServiceConfig({
      COMPUTER_SERVICE_API_KEY: key,
      COMPUTER_SERVICE_URL: "http://computers:3200",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      COMPUTER_IMAGE: "ghcr.io/example/computer:1",
      COMPUTER_DOCKER_NETWORK: "kovobot-computers",
    });

    expect(config.port).toBe(3200);
    expect(config.docker).toEqual({
      host: "unix:///var/run/docker.sock",
      image: "ghcr.io/example/computer:1",
      network: "kovobot-computers",
    });
  });

  test("each Computer's outbound traffic is limited: 50 Mbit/s and 20 new connections a second unless set", () => {
    expect(loadComputerServiceConfig({ COMPUTER_SERVICE_API_KEY: key }).outbound).toEqual({
      mbitPerSecond: 50,
      newConnectionsPerSecond: 20,
    });
    expect(
      loadComputerServiceConfig({
        COMPUTER_SERVICE_API_KEY: key,
        COMPUTER_OUTBOUND_MBIT: "10",
        COMPUTER_NEW_CONNECTIONS_PER_SECOND: "5",
      }).outbound,
    ).toEqual({ mbitPerSecond: 10, newConnectionsPerSecond: 5 });
    expect(problems({ COMPUTER_SERVICE_API_KEY: key, COMPUTER_OUTBOUND_MBIT: "fast", COMPUTER_NEW_CONNECTIONS_PER_SECOND: "0" })).toEqual([
      'COMPUTER_OUTBOUND_MBIT must be a whole number from 1 to 10000, not "fast".',
      'COMPUTER_NEW_CONNECTIONS_PER_SECOND must be a whole number from 1 to 10000, not "0".',
    ]);
  });

  test("only the Docker backend exists so far", () => {
    expect(loadComputerServiceConfig({ COMPUTER_SERVICE_API_KEY: key, COMPUTER_BACKEND: "docker" }).backend).toBe("docker");
    expect(problems({ COMPUTER_SERVICE_API_KEY: key, COMPUTER_BACKEND: "cloud" })).toEqual([
      'COMPUTER_BACKEND must be "docker", not "cloud": other backends aren\'t built yet.',
    ]);
  });

  test("live-view links are signed with COMPUTER_TOKEN_SIGNING_KEY, or with a fresh random key when it is unset", () => {
    const signingKey = "s".repeat(40);
    expect(
      loadComputerServiceConfig({ COMPUTER_SERVICE_API_KEY: key, COMPUTER_TOKEN_SIGNING_KEY: signingKey }).tokenSigningKey,
    ).toBe(signingKey);

    const first = loadComputerServiceConfig({ COMPUTER_SERVICE_API_KEY: key }).tokenSigningKey;
    const second = loadComputerServiceConfig({ COMPUTER_SERVICE_API_KEY: key }).tokenSigningKey;
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(first).not.toBe(second);

    expect(problems({ COMPUTER_SERVICE_API_KEY: key, COMPUTER_TOKEN_SIGNING_KEY: "short" })).toEqual([
      expect.stringMatching(/^COMPUTER_TOKEN_SIGNING_KEY must be at least 32 characters/),
    ]);
  });
});
