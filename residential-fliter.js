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
      existingProxies.add(...proxyNames);
      group.proxies = [...existingProxies];
    }
  };

  for (const proxy of config.proxies) {
    if (proxy.name.includes("落地")) {
      const location = locations.find((loc) => proxy.name.includes(loc));
      if (location && hasLocationGroup(location)) {
        proxy["dialer-proxy"] = location;

        if (hasResidentialGroup(location)) {
          config["proxy-groups"][`${location}落地`].proxies.push(proxy.name);
        } else {
          config["proxy-groups"].push({
            name: `${location}落地`,
            type: "select",
            proxies: [proxy.name],
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

  return config;
}
