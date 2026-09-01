const providers = new Map();
const providerList = [];

function registerProvider(provider) {
    if (!provider || !provider.id) {
        throw new Error("registerProvider: provider must have an 'id' property");
    }
    if (providers.has(provider.id)) return;
    providers.set(provider.id, provider);
    providerList.push(provider);
}

function getProvider(id) {
    const provider = providers.get(id);
    if (!provider) {
        const available = [...providers.keys()].join(", ");
        throw new Error(`Unknown provider: ${id}\n\nAvailable providers:\n  ${available}`);
    }
    return provider;
}

function providerById(name) {
    return providers.get(name);
}

function providerLabel(provider) {
    if (!provider) return "";
    return provider.name || provider.id;
}

function getAllProviders() {
    return [...providerList];
}

module.exports = {
    registerProvider,
    getProvider,
    providerById,
    providerLabel,
    getAllProviders,
};

