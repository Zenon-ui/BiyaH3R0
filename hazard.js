export class hazardtype{
    static Pothole =    type("Pothole","🕳️",true,true);
    static Flooded = new hazardtype("Flooded","🌊",true,true);
    static Ice = new hazardtype("Ice","🧊",true,true);
    static Debris = new hazardtype("Debris","�️",true,true);
    static Construction = new hazardtype("Construction","🏗️",true,true);
    static TrafficJam = new hazardtype("Traffic Jam","🚧",true,true)
    static Accident = new hazardtype("Accident","🚑",true,true);
    static RoadClosure = new hazardtype("Road Closure","🚫",true,true);
    static Landslide = new hazardtype("Landslide","🏔️",true,true);
    static Wildfire = new hazardtype("Wildfire","🔥",true,true);
    static Earthquake = new hazardtype("Earthquake","🌍",true,true);
    static Tornado = new hazardtype("Tornado","🌪️",true,true);
    static Avalanche = new hazardtype("Avalanche","🏔️",true,true);
    static VolcanicEruption = new hazardtype("Volcanic Eruption","🌋",true,true);
    static Tsunami = new hazardtype("Tsunami","🌊",true,true);
    static Hailstorm = new hazardtype("Hailstorm","🌨️",true,true);
    static Heatwave = new hazardtype("Heatwave","🌞",true,true);
    static Blizzard = new hazardtype("Blizzard","❄️",true,true);
    static DustStorm = new hazardtype("Dust Storm","🌪️",true,true);
    static Thunderstorm = new hazardtype("Thunderstorm","⛈️",true,true);
    static TornadoWarning = new hazardtype("Tornado Warning","🌪️",true,true);
    static FloodWarning = new hazardtype("Flood Warning","🌊",true,true);
    static EarthquakeWarning = new hazardtype("Earthquake Warning","🌍",true,true);
    static WildfireWarning = new hazardtype("Wildfire Warning","🔥",true,true);
    static AvalancheWarning = new hazardtype("Avalanche Warning","🏔️",true,true);
    static VolcanicEruptionWarning = new hazardtype("Volcanic Eruption Warning","🌋",true,true);
    static TsunamiWarning = new hazardtype("Tsunami Warning","🌊",true,true);
    static HailstormWarning = new hazardtype("Hailstorm Warning","🌨️",true,true);
    static HeatwaveWarning = new hazardtype("Heatwave Warning","🌞",true,true);
    static BlizzardWarning = new hazardtype("Blizzard Warning","❄️",true,true);
    static DustStormWarning = new hazardtype("Dust Storm Warning","🌪️",true,true);
    static ThunderstormWarning = new hazardtype("Thunderstorm Warning","⛈️",true,true);
    static TrafficAccident = new hazardtype("Traffic Accident","🚑",true,true);
    static Roadwork = new hazardtype("Roadwork","🚧",true,true);
    static BridgeCollapse = new hazardtype("Bridge Collapse","🌉",true,true);
    static TunnelCollapse = new hazardtype("Tunnel Collapse","🕳️",true,true);
    static ChemicalSpill = new hazardtype("Chemical Spill","☣️",true,true);
    static PowerOutage = new hazardtype("Power Outage","💡",true,true);
    static GasLeak = new hazardtype("Gas Leak","🛢️",true,true);
    static  WildlifeCrossing = new hazardtype("Wildlife Crossing","🦌",true,true);
    static FallenTree = new hazardtype("Fallen Tree","🌳",true,true);
    static Rockfall = new hazardtype("Rockfall","🪨",true,true);
    static Snowstorm = new hazardtype("Snowstorm","❄️",true,true);
    static Fog = new hazardtype("Fog","🌫️",true,true);
    static Sandstorm = new hazardtype("Sandstorm","🏜️",true,true);
    static Heat = new hazardtype("Heat","🔥",true,true);
    static Cold = new hazardtype("Cold","❄️",true,true);
    static Rain = new hazardtype("Rain","🌧️",true,true);
    static Snow = new hazardtype("Snow","❄️",true,true);
    static Wind = new hazardtype("Wind","💨",true,true);

    static Lightning = new hazardtype("Lightning","⚡",true,true);
        constructor(label,enoji,weighted,canblock){
        this.label = label;
        this.enoji = enoji;
        this.weighted = weighted;
        this.canblock = canblock;
    }
    static fromLabel(label){
        for (const key in hazardtype) {
            if (hazardtype[key] instanceof hazardtype && hazardtype[key].label === label) {
                return hazardtype[key];
            }
        }

}
}
class hazard {
    constructor(data, fallback, currentOriginLocation) {
        this.id = data.id;
        this.type = data.type instanceof hazardtype ? data.type : hazardtype.fromLabel(data.type);
        this.note = data.note || '';
        this.lat = data.lat ?? fallback.lat;
        this.lng = data.lng ?? fallback.lng;
        this.time = data.time || 'Just now';
        this.locationNote = data.locationNote || currentOriginLocation;
        this.location = data.location || null;
        this.speedAtReport = data.speedAtReport || 0;
        this.timestamp = data.timestamp || new Date().toISOString();
        this.syncStatus = data.syncStatus || 'pending';

        this.confirmations = data.confirmations ?? 0;
        this.disputes = data.disputes ?? 0;
        this.initialConfidence = data.initialConfidence ?? calculateInitialConfidence(data);

        this.confidence = data.confidence ?? Math.max(0, Math.min(100,
            this.initialConfidence + this.confirmations * 8 - this.disputes * 12
        ));

        const status = getConfidenceStatus(this.confidence);
        this.confidenceStatus = data.confidenceStatus ?? status.label;
        this.badge = data.badge ?? status.badge;
        this.badgeText = data.badgeText ?? status.badgeText;

        this.avoidenabled = data.avoidenabled ?? true;
        this.graphEdgeid = null;
    }

    get label(){ return this.type.label; }
    toggleAvoid(){ this.avoidenabled = !this.avoidenabled; }
    routingweightmult(){
        if(!this.avoidenabled){ return 1; }
        return this.type.canblock ? 1000 : 1 + this.type.weighted;
    }
}