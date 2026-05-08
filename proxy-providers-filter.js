const LOCATION_KEYWORDS = {
  香港: ["香港", "港", "HK", "Hong Kong"],
  台湾: ["台湾", "台", "TW", "Taiwan", "台北", "台中"],
  日本: ["日本", "日", "JP", "Japan", "东京", "大阪"],
  韩国: ["韩国", "韩", "KR", "Korea", "首尔"],
  美国: ["美国", "美", "US", "USA", "United States", "洛杉矶", "纽约", "硅谷", "旧金山"],
  新加坡: ["新加坡", "坡", "狮城", "SG", "Singapore"],
};

function getLocation(proxy) {
  for (const [location, keywords] of Object.entries(LOCATION_KEYWORDS)) {
    const hasKeyword = keywords.some((keyword) => proxy.name.includes(keyword));
    if (hasKeyword) return location;
  }
  return null;
}

function generateProxyProvider(name) {
  return {
    name,
    type: "inline",
    payload: [],
  };
}

function main(config) {
  const proxyProviders = {};
  const addProxyToProvider = (proxy, provider) => {
    if (!proxyProviders[provider]) {
      proxyProviders[provider] = generateProxyProvider(provider);
    }
    proxyProviders[provider].payload.push(proxy);
  };

  for (const proxy of config.proxies) {
    const location = getLocation(proxy);
    if (location) {
      addProxyToProvider(proxy, location);
    } else {
      addProxyToProvider(proxy, "其他地区");
    }
  }

  config.proxies = [];
  config["proxy-providers"] = proxyProviders;
  return config;
}
