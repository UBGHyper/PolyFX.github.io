;
export class PolyMod {
    constructor() {
        this.loaded = false;
        this.init = async (pmlInstance) => { };
        this.postInit = () => { };
        this.onGameLoad = () => { };
        this.preInit = (pmlInstance) => { };
        this.offlineMode = false;
    }
    get iconSrc() {
        return this.IconSrc;
    }
    set iconSrc(src) {
        this.IconSrc = src;
    }
    set setLoaded(status) {
        this.loaded = status;
    }
    get isLoaded() {
        return this.loaded;
    }
    get baseUrl() {
        return this.modBaseUrl;
    }
    set baseUrl(url) {
        this.modBaseUrl = url;
    }
    get savedLatest() {
        return this.latestSaved;
    }
    set savedLatest(latest) {
        this.latestSaved = latest;
    }
    get initialized() {
        return this.modInitialized;
    }
    set initialized(initState) {
        this.modInitialized = initState;
    }
}
export var MixinType;
(function (MixinType) {
    MixinType[MixinType["HEAD"] = 0] = "HEAD";
    MixinType[MixinType["TAIL"] = 1] = "TAIL";
    MixinType[MixinType["OVERRIDE"] = 2] = "OVERRIDE";
    MixinType[MixinType["INSERT"] = 3] = "INSERT";
    MixinType[MixinType["REPLACEBETWEEN"] = 5] = "REPLACEBETWEEN";
    MixinType[MixinType["REMOVEBETWEEN"] = 6] = "REMOVEBETWEEN";
    MixinType[MixinType["CLASSINSERT"] = 8] = "CLASSINSERT";
    MixinType[MixinType["CLASSREMOVE"] = 4] = "CLASSREMOVE";
    MixinType[MixinType["CLASSREPLACE"] = 7] = "CLASSREPLACE";
})(MixinType || (MixinType = {}));
export var PhysicsMixinType;
(function (PhysicsMixinType) {
    PhysicsMixinType[PhysicsMixinType["PATCH_F32"] = 0] = "PATCH_F32";
    PhysicsMixinType[PhysicsMixinType["PATCH_I32"] = 1] = "PATCH_I32";
})(PhysicsMixinType || (PhysicsMixinType = {}));
export var SettingType;
(function (SettingType) {
    SettingType["BOOL"] = "boolean";
    SettingType["SLIDER"] = "slider";
    SettingType["CUSTOM"] = "custom";
})(SettingType || (SettingType = {}));
