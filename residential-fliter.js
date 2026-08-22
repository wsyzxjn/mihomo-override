const FULL_PORT_SERVER_PATTERN = /(?:v51124-4\.qpon|rtysjur\.quest)$/i;
const LOCATIONS = ["香港", "台湾", "日本", "韩国", "美国", "新加坡"];

function getGroup(config, name) {
  return config["proxy-groups"].find((group) => group.name === name);
}

function addProxy(group, proxyName) {
  if (!group.proxies.includes(proxyName)) group.proxies.push(proxyName);
}

function populateFullPortGroup(config) {
  const group = getGroup(config, "全端口");
  if (!group) return;

  group.proxies = config.proxies
    .filter((proxy) => FULL_PORT_SERVER_PATTERN.test(proxy.server ?? ""))
    .map((proxy) => proxy.name);
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

function main(config) {
  populateFullPortGroup(config);
  configureHomeBroadband(config);
  configureRegionalResidential(config);
  return config;
}
