// NOTE: This file isn't currently imported anywhere in the app — the
// classes BiyaHERO.js actually uses are defined directly inside it
// (search for "class hazardtype" there). This standalone copy is kept
// in sync with the same icon-key taxonomy anyway, so it doesn't go
// stale and mislead anyone who does start using it.
export class hazardtype{
    static Pothole = new hazardtype("Pothole","pothole",true,true);
    static Flooded = new hazardtype("Flooded Street","water",true,true);
    static Ice = new hazardtype("Ice","ice",true,true);
    static Debris = new hazardtype("Debris","debris",true,true);
    static Construction = new hazardtype("Road Construction","cone",true,true);
    static TrafficJam = new hazardtype("Traffic Jam","congestion",true,true)
    static Accident = new hazardtype("Accident","impact",true,true);
    static RoadClosure = new hazardtype("Road Closure","barrier",true,true);
    static Landslide = new hazardtype("Landslide","landslide",true,true);
    static Wildfire = new hazardtype("Wildfire","flame",true,true);
    static Earthquake = new hazardtype("Earthquake","quake",true,true);
    static Tornado = new hazardtype("Tornado","swirl",true,true);
    static Avalanche = new hazardtype("Avalanche","landslide",true,true);
    static VolcanicEruption = new hazardtype("Volcanic Eruption","volcano",true,true);
    static Tsunami = new hazardtype("Tsunami","water",true,true);
    static Hailstorm = new hazardtype("Hailstorm","hail",true,true);
    static Heatwave = new hazardtype("Heatwave","flame",true,true);
    static Blizzard = new hazardtype("Blizzard","snowflake",true,true);
    static DustStorm = new hazardtype("Dust Storm","swirl",true,true);
    static Thunderstorm = new hazardtype("Thunderstorm","storm",true,true);
    static TornadoWarning = new hazardtype("Tornado Warning","swirl",true,true);
    static FloodWarning = new hazardtype("Flood Warning","water",true,true);
    static EarthquakeWarning = new hazardtype("Earthquake Warning","quake",true,true);
    static WildfireWarning = new hazardtype("Wildfire Warning","flame",true,true);
    static AvalancheWarning = new hazardtype("Avalanche Warning","landslide",true,true);
    static VolcanicEruptionWarning = new hazardtype("Volcanic Eruption Warning","volcano",true,true);
    static TsunamiWarning = new hazardtype("Tsunami Warning","water",true,true);
    static HailstormWarning = new hazardtype("Hailstorm Warning","hail",true,true);
    static HeatwaveWarning = new hazardtype("Heatwave Warning","flame",true,true);
    static BlizzardWarning = new hazardtype("Blizzard Warning","snowflake",true,true);
    static DustStormWarning = new hazardtype("Dust Storm Warning","swirl",true,true);
    static ThunderstormWarning = new hazardtype("Thunderstorm Warning","storm",true,true);
    static TrafficAccident = new hazardtype("Traffic Accident","impact",true,true);
    static Roadwork = new hazardtype("Roadwork","cone",true,true);
    static BridgeCollapse = new hazardtype("Bridge Collapse","bridge",true,true);
    static TunnelCollapse = new hazardtype("Tunnel Collapse","tunnel",true,true);
    static ChemicalSpill = new hazardtype("Chemical Spill","hazmat",true,true);
    static PowerOutage = new hazardtype("Power Outage","power",true,true);
    static GasLeak = new hazardtype("Gas Leak","gas",true,true);
    static  WildlifeCrossing = new hazardtype("Wildlife Crossing","paw",true,true);
    static FallenTree = new hazardtype("Fallen Tree","tree",true,true);
    static Rockfall = new hazardtype("Rockfall","debris",true,true);
    static Snowstorm = new hazardtype("Snowstorm","snowflake",true,true);
    static Fog = new hazardtype("Fog","fog",true,true);
    static Sandstorm = new hazardtype("Sandstorm","swirl",true,true);
    static Heat = new hazardtype("Heat","flame",true,true);
    static Cold = new hazardtype("Cold","ice",true,true);
    static Rain = new hazardtype("Rain","water",true,true);
    static Snow = new hazardtype("Snow","snowflake",true,true);
    static Wind = new hazardtype("Wind","wind",true,true);
    static Lightning = new hazardtype("Lightning","storm",true,true);
    static RoadBump = new hazardtype("Road Bump","bump",true,true);
    static TemporaryClosure = new hazardtype("Temporary Closure","barrier",true,true);

        constructor(label,icon,weighted,canblock){
        this.label = label;
        this.icon = icon;
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
