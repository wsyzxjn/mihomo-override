const RESIDENTIAL_PATTERN = /落地|家宽|住宅|家庭宽带|residential|home\s*broadband/i;
const LOCATIONS = ["香港", "台湾", "日本", "韩国", "美国", "新加坡"];
const SCRIPT_ARGUMENTS =
  typeof $arguments === "object" && $arguments ? $arguments : {};
const HTTP_META_API = String(
  SCRIPT_ARGUMENTS.http_meta_api ?? "http://127.0.0.1:9876",
).replace(/\/$/, "");
const HTTP_META_AUTHORIZATION = String(
  SCRIPT_ARGUMENTS.http_meta_authorization ?? "",
);
const PROBE_URL = "http://connectivitycheck.platform.hicloud.com/generate_204";
const PROBE_STATUS = /^204$/;
const PROBE_TIMEOUT = 8000;
const STARTUP_TIMEOUT = 10000;
const BATCH_SIZE = 20;
const CONCURRENCY = 8;
const SUCCESS_CACHE_TTL = 6 * 60 * 60 * 1000;
const FALLBACK_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const LAST_SUCCESS_CACHE_KEY = "residential-full-port:last-success:v1";

function getGroup(config, name) {
  return config["proxy-groups"].find((group) => group.name === name);
}

function addProxy(group, proxyName) {
  if (!group.proxies.includes(proxyName)) group.proxies.push(proxyName);
}

function isResidential(proxy) {
  return RESIDENTIAL_PATTERN.test(proxy.name ?? "");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !/^(name|_.*)$/i.test(key))
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function fingerprint(proxy) {
  return require("crypto")
    .createHash("sha256")
    .update(JSON.stringify(stableValue(proxy)))
    .digest("hex");
}

async function request(options) {
  let lastError;
  const retries = options.retries ?? 1;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await $substore.http[options.method ?? "get"]({
        ...options,
        timeout: options.timeout ?? PROBE_TIMEOUT,
      });
    } catch (error) {
      lastError = error;
      if (attempt < retries) await $substore.wait(500);
    }
  }
  throw lastError;
}

async function runTasks(tasks, concurrency) {
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      await tasks[index]();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
}

function httpMetaHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (HTTP_META_AUTHORIZATION) {
    headers.Authorization = HTTP_META_AUTHORIZATION;
  }
  return headers;
}

function makeProbePair(relay, residential, pairIndex) {
  const relayIndex = pairIndex * 2;
  const relayProxy = { ...relay, name: `relay-${pairIndex}` };
  const residentialProxy = {
    ...residential,
    name: `residential-${pairIndex}`,
    "dialer-proxy": `proxy-${relayIndex}`,
  };
  delete relayProxy["dialer-proxy"];
  return [relayProxy, residentialProxy];
}

async function probeBatch(pairs) {
  const proxies = pairs.flatMap(({ relay, residential }, index) =>
    makeProbePair(relay.proxy, residential.proxy, index),
  );
  const lifetime = STARTUP_TIMEOUT + pairs.length * PROBE_TIMEOUT;
  let pid;

  try {
    const response = await request({
      method: "post",
      url: `${HTTP_META_API}/start`,
      headers: httpMetaHeaders(),
      body: JSON.stringify({ proxies, timeout: lifetime }),
      timeout: 15000,
      retries: 0,
    });
    const result = JSON.parse(response.body);
    pid = result.pid;
    const validPorts =
      Array.isArray(result.ports) &&
      result.ports.length === proxies.length &&
      result.ports.every(
        (port) => Number.isInteger(port) && port >= 1 && port <= 65535,
      );
    if (!pid || !validPorts) {
      throw new Error("HTTP META 返回了无效的 PID 或端口列表");
    }

    await $substore.wait(2000);
    const outcomes = Array(pairs.length).fill(null);
    await runTasks(
      pairs.map((pair, index) => async () => {
        const port = result.ports[index * 2 + 1];
        try {
          const startedAt = Date.now();
          const probe = await request({
            method: "head",
            proxy: `http://127.0.0.1:${port}`,
            url: PROBE_URL,
            retries: 2,
          });
          const status = Number(probe.status ?? probe.statusCode ?? 200);
          outcomes[index] = PROBE_STATUS.test(String(status)) ? "pass" : "fail";
          $substore.info(
            `[全端口] ${pair.relay.proxy.name} → ${pair.residential.proxy.name}: ${status}, ${Date.now() - startedAt}ms`,
          );
        } catch (error) {
          outcomes[index] = "unknown";
          $substore.error(
            `[全端口] ${pair.relay.proxy.name} → ${pair.residential.proxy.name}: ${error.message ?? error}`,
          );
        }
      }),
      CONCURRENCY,
    );
    return outcomes;
  } finally {
    if (pid) {
      try {
        await request({
          method: "post",
          url: `${HTTP_META_API}/stop`,
          headers: httpMetaHeaders(),
          body: JSON.stringify({ pid: [pid] }),
          timeout: 10000,
        });
      } catch (error) {
        $substore.error(`[全端口] HTTP META 清理失败: ${error.message ?? error}`);
      }
    }
  }
}

async function probeFullPortRelays(config) {
  const group = getGroup(config, "全端口");
  if (!group) return;

  const residential = config.proxies
    .filter(isResidential)
    .map((proxy, index) => ({ proxy, id: `${fingerprint(proxy)}:${index}` }));
  const candidates = config.proxies
    .filter((proxy) => !isResidential(proxy))
    .map((proxy, index) => ({ proxy, id: `${fingerprint(proxy)}:${index}` }));
  const previous = scriptResourceCache.get(LAST_SUCCESS_CACHE_KEY) ?? {};
  const previousFingerprints = new Set(previous.fingerprints ?? []);

  const restorePrevious = (reason) => {
    const previousNames = candidates
      .filter(({ proxy }) => previousFingerprints.has(fingerprint(proxy)))
      .map(({ proxy }) => proxy.name);
    group.proxies = previousNames.length ? previousNames : ["DIRECT"];
    $substore.error(
      `${reason}；${previousNames.length ? `保留 ${previousNames.length} 个上次成功结果` : "暂无历史结果，临时回退 DIRECT"}`,
    );
  };

  if (!residential.length || !candidates.length) {
    restorePrevious(
      `[全端口] 无法探测：候选 ${candidates.length}，家宽/落地 ${residential.length}`,
    );
    return;
  }

  const passedTargets = new Map(candidates.map(({ id }) => [id, new Set()]));
  const uncachedPairs = [];

  for (const relay of candidates) {
    for (const target of residential) {
      const cacheKey = `residential-full-port:pair:v1:${relay.id}:${target.id}`;
      const cached = scriptResourceCache.get(cacheKey);
      if (cached?.ok) {
        passedTargets.get(relay.id).add(target.id);
      } else {
        uncachedPairs.push({ relay, residential: target, cacheKey });
      }
    }
  }

  $substore.info(
    `[全端口] 候选 ${candidates.length}，家宽/落地 ${residential.length}，需探测 ${uncachedPairs.length} 条链路`,
  );

  let hasUnknown = false;
  for (let offset = 0; offset < uncachedPairs.length; offset += BATCH_SIZE) {
    const batch = uncachedPairs.slice(offset, offset + BATCH_SIZE);
    let outcomes;
    try {
      outcomes = await probeBatch(batch);
    } catch (error) {
      hasUnknown = true;
      $substore.error(`[全端口] 批次启动失败: ${error.message ?? error}`);
      continue;
    }

    outcomes.forEach((outcome, index) => {
      const pair = batch[index];
      if (outcome === "unknown") {
        hasUnknown = true;
        return;
      }
      if (outcome !== "pass") return;
      passedTargets.get(pair.relay.id).add(pair.residential.id);
      scriptResourceCache.set(
        pair.cacheKey,
        { ok: true, timestamp: Date.now() },
        SUCCESS_CACHE_TTL,
      );
    });
  }

  if (hasUnknown) {
    restorePrevious("[全端口] 本轮存在无法确认的探测结果，不更新成功集合");
    return;
  }

  const passed = candidates.filter(
    ({ id }) => passedTargets.get(id).size === residential.length,
  );

  if (passed.length) {
    group.proxies = passed.map(({ proxy }) => proxy.name);
    scriptResourceCache.set(
      LAST_SUCCESS_CACHE_KEY,
      {
        fingerprints: passed.map(({ proxy }) => fingerprint(proxy)),
        timestamp: Date.now(),
      },
      FALLBACK_CACHE_TTL,
    );
    $substore.info(
      `[全端口] ${passed.length}/${candidates.length} 个候选通过全部 ${residential.length} 个家宽/落地节点`,
    );
    return;
  }

  restorePrevious("[全端口] 本轮无候选通过");
}

function configureHomeBroadband(config) {
  const group = getGroup(config, "家宽");
  if (!group) return;

  for (const proxy of config.proxies) {
    if (!proxy.name.includes("家宽")) continue;
    proxy["dialer-proxy"] = "全端口";
    addProxy(group, proxy.name);
  }
}

function configureRegionalResidential(config) {
  const proxyGroups = config["proxy-groups"];

  for (const proxy of config.proxies) {
    if (!proxy.name.includes("落地")) continue;

    const location = LOCATIONS.find((candidate) => proxy.name.includes(candidate));
    if (!location || !getGroup(config, location)) {
      console.warn(`无法为代理 ${proxy.name} 配置前置代理，未找到匹配的地区代理组。`);
      continue;
    }

    const residentialGroupName = `${location}落地`;
    const transitGroupName = `${location}落地中转节点`;
    proxy["dialer-proxy"] = transitGroupName;

    let residentialGroup = getGroup(config, residentialGroupName);
    if (!residentialGroup) {
      residentialGroup = {
        name: residentialGroupName,
        type: "select",
        proxies: [],
      };
      proxyGroups.push(residentialGroup);
    }
    addProxy(residentialGroup, proxy.name);

    if (!getGroup(config, transitGroupName)) {
      proxyGroups.push({
        name: transitGroupName,
        type: "select",
        "include-all": true,
        "exclude-filter": "落地|家宽",
      });
    }
  }

  const regionalResidentialGroups = proxyGroups
    .filter((group) => group.name.endsWith("落地"))
    .map((group) => group.name);

  for (const group of proxyGroups) {
    if (
      group.type !== "select" ||
      group.name.endsWith("落地") ||
      group.name.endsWith("落地中转节点") ||
      group.name === "全端口" ||
      group.name === "家宽"
    ) {
      continue;
    }
    const proxies = new Set(group.proxies);
    proxies.delete("DIRECT");
    regionalResidentialGroups.forEach((name) => proxies.add(name));
    proxies.add("DIRECT");
    group.proxies = [...proxies];
  }
}

async function main(config) {
  if (!Array.isArray(config?.proxies) || !Array.isArray(config?.["proxy-groups"])) {
    $substore.error("[全端口] 配置缺少 proxies 或 proxy-groups，跳过处理");
    return config;
  }

  try {
    await probeFullPortRelays(config);
  } catch (error) {
    $substore.error(`[全端口] 探测异常，保留原配置: ${error.message ?? error}`);
  }
  configureHomeBroadband(config);
  configureRegionalResidential(config);
  return config;
}
