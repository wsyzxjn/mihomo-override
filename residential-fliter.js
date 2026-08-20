function main(config) {
  const locations = ["香港", "台湾", "日本", "韩国", "美国", "新加坡"];
  const hasLocationGroup = (location) => {
    return config["proxy-groups"].some((group) => group.name === location);
  };
  const hasResidentialGroup = (location) => {
    return config["proxy-groups"].some(
      (group) => group.name === `${location}落地`,
    );
  };
  const addProxiesToAllGroup = (proxyNames, skipCallback) => {
    for (const group of config["proxy-groups"]) {
      if (skipCallback?.(group)) continue;
      const existingProxies = new Set(group.proxies);
      existingProxies.delete("DIRECT");
      [...proxyNames, "DIRECT"].forEach((proxy) => existingProxies.add(proxy));
      group.proxies = [...existingProxies];
    }
  };

  for (const proxy of config.proxies) {
    if (proxy.name.includes("落地")) {
      const location = locations.find((loc) => proxy.name.includes(loc));
      if (location && hasLocationGroup(location)) {
        proxy["dialer-proxy"] = `${location}落地中转节点`;

        const proxyGroups = config["proxy-groups"];

        if (hasResidentialGroup(location)) {
          proxyGroups
            .find((group) => group.name === `${location}落地`)
            .proxies.push(proxy.name);
        } else {
          proxyGroups.push({
            name: `${location}落地`,
            type: "select",
            proxies: [proxy.name],
          });
        }

        if (
          !proxyGroups.some((group) => group.name === `${location}落地中转节点`)
        ) {
          proxyGroups.push({
            name: `${location}落地中转节点`,
            type: "select",
            "include-all": true,
            "exclude-filter": "落地",
          });
        }
      } else {
        console.warn(
          `无法为代理 ${proxy.name} 配置前置代理，未找到匹配的地区代理组。`,
        );
      }
    }
  }

  const residentialGroupNames = config["proxy-groups"]
    .filter((group) => group.name.endsWith("落地"))
    .map((group) => group.name);
  addProxiesToAllGroup(
    residentialGroupNames,
    (group) => group.name.endsWith("落地") || group.type !== "select",
  );

  // ikuu: no dest-port filter. Tag by server so they can be a dedicated group.
  const isIkuu = (proxy) => {
    const server = String(proxy.server || "");
    return (
      server.includes("v51124-4.qpon") || server.includes("rtysjur.quest")
    );
  };
  let ikuuCount = 0;
  for (const proxy of config.proxies) {
    if (!isIkuu(proxy)) continue;
    if (!proxy.name.startsWith("[ikuu] ")) {
      proxy.name = `[ikuu] ${proxy.name}`;
    }
    ikuuCount += 1;
  }
  if (ikuuCount > 0) {
    const groups = config["proxy-groups"];
    if (!groups.some((group) => group.name === "ikuu")) {
      const ikuuGroup = {
        name: "ikuu",
        type: "select",
        "include-all": true,
        filter: "(?i)\\[ikuu\\]",
      };
      const manualIdx = groups.findIndex((group) => group.name === "手动选择");
      groups.splice(manualIdx >= 0 ? manualIdx + 1 : 0, 0, ikuuGroup);
    }
    for (const group of groups) {
      if (!Array.isArray(group.proxies)) continue;
      if (!group.proxies.includes("手动选择")) continue;
      if (group.proxies.includes("ikuu")) continue;
      const insertAt = group.proxies.indexOf("手动选择") + 1;
      group.proxies.splice(insertAt, 0, "ikuu");
    }
    const extraRules = [
      "DOMAIN,matsuri.imoutofu.me,ikuu",
      "IP-CIDR,99.225.216.87/32,ikuu,no-resolve",
    ];
    config.rules = extraRules.concat(config.rules || []);
  }

  return config;
}
