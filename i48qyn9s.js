
// See https://www.zigbee2mqtt.io/advanced/support-new-devices/02_support_new_tuya_devices.html
const fz = require('zigbee-herdsman-converters/converters/fromZigbee');
const tz = require('zigbee-herdsman-converters/converters/toZigbee');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const reporting = require('zigbee-herdsman-converters/lib/reporting');
const extend = require('zigbee-herdsman-converters/lib/extend');
const e = exposes.presets;
const ea = exposes.access;

const tuya = require('zigbee-herdsman-converters/lib/tuya');
const globalStore = require('zigbee-herdsman-converters/lib/store');
const legacy = require('zigbee-herdsman-converters/lib/legacy');
const ota = require('zigbee-herdsman-converters/lib/ota');

const strPadStart = (val, count=2, prefix='0') => {
    return String(val).padStart(count,prefix);
};

const format_dtYYYYMMDD_HHMM = (date) => {
    if ( !date )
        return null;
    const dt = { year: date.getFullYear(), month: date.getMonth()+1, day: date.getDate(), 
                 hour: date.getHours(), minute: date.getMinutes() };
    return `${dt.year}-${strPadStart(dt.month)}-${strPadStart(dt.day)} ${strPadStart(dt.hour)}:${strPadStart(dt.minute)}`;
};

const parse_dtYYYYMMDD_HHMM = (dateStr) => {
    try {
        if (!dateStr)
            return undefined;
        return new Date(dateStr);
    }
    catch {
        const numberPattern = /[\d]+/g;
        const arr = dateStr.match(numberPattern);
        if (arr.length < 3 || arr.length > 5)
            throw new Error(`DateTime '${dateStr}' not in format: YYYY-MM-DD [HH[:MM]]`);
        const dt = { year: parseInt(arr[0]), month: parseInt(arr[1]||"1"), day: parseInt(arr[2]||"1"), 
                     hour: parseInt(arr[3]||"0"), minutes: parseInt(arr[4]||"0") };
        if (dt.year < 2000 || dt.year >= 2255 || dt.month < 1 || dt.month > 12 || td.day < 1 || td.day > 31)
            throw new Error(`parse_dtYYYYMMDD_HHMM: year, month or day out of range in ${dateStr}`);
        if (dt.hour < 0 || td.hour > 24 || dt.minutes < 0 || dt.minutes >= 60)
            throw new Error(`parse_dtYYYYMMDD_HHMM: hour or minute out of range in ${dateStr}`);
        return new Date(dt.year, dt.month-1, dt.day, dt.hour, dt.minutes);
    }
};

const parse_dtStartStop = (startStopStr) => {
    if (!startStopStr)
        return undefined;
    const start_stop = startStopStr.split(/[|,;]/g);
    if (start_stop.length != 2)
        throw new Error(`Format error in start stop. Need one seperator '|' between start and stop in: ${txt}`);
    const start = parse_dtYYYYMMDD_HHMM(start_stop[0].trim());
    const hourMillis = 60 * 60 * 1000;
    let stop = start_stop[1].trim();
    if (stop.endsWith('d')) 
        stop = new Date(start.getTime() + ((parseInt(stop.substring(0, stop.length-1).trim()) || 1) * hourMillis * 24));
    else if (stop.endsWith('h'))
        stop = new Date(start.getTime() + ((parseInt(stop.substring(0, stop.length-1).trim()) || 1) * hourMillis));
    else
        stop = parse_dtYYYYMMDD_HHMM(stop);
    if (start.getTime() > stop.getTime())
        throw new Error(`Start date/time must be smaller than stop date/time in: ${startStopStr}`);
    return [start, stop];
}

const first_obj_prop = (obj, props) => {
    for (const prop of props)
        if (obj.hasOwnProperty(prop))
            return prop;
    return null;
};

const dataPoints = {
    zsBoostHeating: 106, // ex zsBinaryOne
    zsWindowOpen: 107, // ex zsBinaryTwo. TODO: never occured yet
}

const thermostatPresets = {
    0: 'schedule',
    1: 'manual',
    2: 'comfort',
    3: 'eco',
    4: 'boost',
    5: 'holiday',
    6: 'holiday_ahead', // separate preset, since valve is not moved according to holiday_temperature
    7: 'frost_protection', // system_mode='heat' with current_heating_setpoint=0
    8: 'summer_mode' // system_mode='heat' with current_heating_setpoint=30
};

const thermostatSystemModes = legacy.thermostatSystemModes3;
const thermostatSystemModesConverter = tuya.valueConverterBasic.lookup({'auto': tuya.enum(0), 'heat': tuya.enum(1), 'off': tuya.enum(2)});

// calculate preset and valve_state (not reported by device)
const calc_preset_valve_state = (state) => {
    // TODO: 'window' open state

    if (state.boost_heating === 'ON') // highest priority
        return {valve_state: 'OPEN', preset: 'boost'};
    
    const loc_temp = state.local_temperature || 17;
    let ref_temp = state.current_heating_setpoint_auto | 17;
    if (state.system_mode === 'off') { // holiday
        const [start, stop] = parse_dtStartStop(state.holiday_start_stop || '2000-01-01 00:00 | 1h');
        const now_ms = new Date().getTime();
        // no need to check if holiday in the past, because device will set to system_mode='auto'
        const preset = now_ms >= start.getTime() ? 'holiday' : 'holiday_ahead';
        if (now_ms >= start.getTime() && now_ms <= stop.getTime() )
            return {valve_state: loc_temp < state.holiday_temperature ? 'OPEN' : 'CLOSED', preset: preset};
        else // TODO: holiday_temperature is definitely not used, but check if current_heating_setpoint_auto is the correct one.
            return {valve_state: loc_temp < ref_temp ? 'OPEN' : 'CLOSED', preset: preset};
    }
    else if (state.system_mode === 'auto')
        return {valve_state: loc_temp < ref_temp ? 'OPEN' : 'CLOSED', preset: 'schedule'};
    
    ref_temp = state.current_heating_setpoint || 17; // below with system_mode == 'heat'
    if (ref_temp == 30) // only valid if: system_mode == 'heat' (checked above)
        return {valve_state: 'OPEN', preset: 'summer_mode'};
    else if (ref_temp == 0) // ditto
        return {valve_state: loc_temp < 5 ? 'OPEN' : 'CLOSED', preset: 'frost_protection'}; // 5°C hard coded in device?
    else if (ref_temp == (state.eco_temperature || 17.0))
        return {valve_state: loc_temp < ref_temp ? 'OPEN' : 'CLOSED', preset: 'eco'};
    else if (ref_temp == (state.comfort_temperature || 21.0))
        return {valve_state: loc_temp < ref_temp ? 'OPEN' : 'CLOSED', preset: 'comfort'};
    else
        return {valve_state: loc_temp < ref_temp ? 'OPEN' : 'CLOSED', preset: 'manual'};
}

const toZigbeePreset = (dpSystemMode=legacy.dataPoints.zsMode, 
                        dpCurrentHeatingSetpoint=legacy.dataPoints.zsHeatingSetpoint,
                        dpBoostHeating=dataPoints.zsBoostHeating,
                        ) => {
    return {
        key: ['preset'],
        convertSet: async (entity, key, value, meta) => { 
            meta.logger.debug(`toZigbeePreset.convertSet(${key} = ${value})`);
            const state = meta.state;
            const msg = meta.message || {};
            const new_state = {...state, ...msg};
            const ret = {};
            if (key === 'preset') {
                ret.preset = value;
                if ( ret.preset === 'boost' ) { // highest priority 
                    await legacy.sendDataPointBool(entity, dpBoostHeating, true);
                    ret.boost_heating = 'ON';
                }
                else {
                    if (state.boost_heating !== 'OFF') {
                        await legacy.sendDataPointBool(entity, dpBoostHeating, false);
                        ret.boost_heating = 'OFF';
                    }
                }
                switch (value) {
                    case 'holiday': case 'holiday_ahead':
                        if (state.system_mode !== 'off')
                            ret.system_mode = 'off';
                        // frost_protection and summer_mode only valid within system_mode == 'heat'
                        //if (state.current_heating_setpoint == 0 || state.current_heating_setpoint == 30)
                        //    ret.current_heating_setpoint = comfort - 0.5 ;
                        break;
                    case 'schedule':
                        if (state.system_mode !== 'auto')
                            ret.system_mode = 'auto';
                        // frost_protection and summer_mode only valid within system_mode == 'heat'
                        //if (state.current_heating_setpoint == 0 || state.current_heating_setpoint == 30)
                        //    ret.current_heating_setpoint = comfort - 0.5 ;
                        break;
                    case 'frost_protection':
                        if (state.system_mode !== 'heat')
                            ret.system_mode = 'heat';
                        if (state.current_heating_setpoint != 0)
                            ret.current_heating_setpoint = 0;
                        break;
                    case 'summer_mode':
                        if (state.system_mode !== 'heat')
                            ret.system_mode = 'heat';
                        if (state.current_heating_setpoint != 30)
                            ret.current_heating_setpoint = 30;
                        break;
                    case 'eco':
                        if (state.system_mode !== 'heat')
                            ret.system_mode = 'heat';
                        if (state.current_heating_setpoint != (new_state.eco_temperature || 17))
                            ret.current_heating_setpoint = new_state.eco_temperature || 17;
                        break;
                    case 'comfort':
                        if (state.system_mode !== 'heat')
                            ret.system_mode = 'heat';
                        if (state.current_heating_setpoint != (new_state.comfort_temperature || 21))
                            ret.current_heating_setpoint = new_state.comfort_temperature || 21;
                        break;
                    case 'manual':
                        if (state.system_mode !== 'heat')
                            ret.system_mode = 'heat';
                        if (state.current_heating_setpoint == 0 || state.current_heating_setpoint == 30 
                            || state.current_heating_setpoint == (new_state.eco_temperature || 17)
                            || state.current_heating_setpoint == (new_state.comfort_temperature || 21))
                            ret.current_heating_setpoint = (new_state.comfort_temperature || 21) - 0.5; // something reasonable but nothing of above
                        break;
                    case 'boost':  break; // done above
                    default:       throw new Error(`Unknown preset ${ret.preset} in toZigbeePreset`);
                }
                if (ret.system_mode && ret.system_mode !== state.system_mode)
                    await legacy.sendDataPointEnum(entity, dpSystemMode, thermostatSystemModesConverter.to(ret.system_mode));
                if ( ret.hasOwnProperty('current_heating_setpoint') && ret.current_heating_setpoint != state.current_heating_setpoint )
                    await legacy.sendDataPointValue(entity, dpCurrentHeatingSetpoint, tuya.valueConverterBasic.divideBy(2).to(ret.current_heating_setpoint));
                Object.assign(ret, calc_preset_valve_state({...new_state, ...ret}));
                return {state: ret};
            }
            else
                meta.warn(`toZigbeePreset: Can not handle key with: ${key}=${value}`);
        },
    };
};

const fromZigbeeHoliday = (dpHoliday=103) => {
    return {
        cluster: 'manuSpecificTuya',
        type: ['commandDataResponse', 'commandDataReport'],
        convert: (model, msg, publish, options, meta) => {
            const dpValue = legacy.firstDpValue(msg, meta, 'zs_holiday_from');
            const dp = dpValue.dp;
            const v = legacy.getDataValue(dpValue);
            if (dp != dpHoliday) // holiday
                return undefined;
            meta.logger.debug(`fromZigbeeHoliday.convert(${dp} = ${JSON.stringify(v)})`);
            const start = { year: v[0] + 2000, month: v[1], day: v[2], hour: v[3], minute: v[4] };
            const temperature = v[5] / 2;
            const duration_hours = (v[6] << 8) + v[7];
            const startDate = new Date(start.year, start.month-1, start.day, start.hour, start.minute);
            const hourMillis = 60 * 60 * 1000;
            const stopDate = new Date(startDate.getTime() + (duration_hours * hourMillis));
            return {
                holiday_start_stop: `${format_dtYYYYMMDD_HHMM(startDate)} | ${format_dtYYYYMMDD_HHMM(stopDate)}`,
                holiday_temperature: temperature,
            };
        },
    };
};

const toZigbeeHoliday = (dpHoliday=legacy.dataPoints.zsAwaySetting, dpSystemMode=legacy.dataPoints.zsMode) => {
    return {
        key: ['holiday_start_stop', 'holiday_temperature'],
        convertSet: async (entity, key, value, meta) => { 
            meta.logger.debug(`toZigbeeHoliday.convertSet(${key} = ${value})`);
            const msg = meta.message || {};
            const props = ['holiday_start_stop', 'holiday_temperature'];
            const first_prop = first_obj_prop(msg, props);
            if (first_prop !== key) { // only process for first prop of this compound
                if ( !props.includes(key) )
                    throw new Error(`Property ${key} not known in toZigbeeHoliday`);
                return undefined; 
            }
            const new_state = {...meta.state, ...msg};
            const temperature = new_state.holiday_temperature || 15.0;
            if ( temperature < 0.5 || temperature > 29.5 )
                throw new Error(`Holiday temperature ${temperature} is out of valid range (0.5-29.5) in toZigbeeHoliday`);

            const [start, stop] = parse_dtStartStop(new_state.holiday_start_stop || '2000-01-01 00:00 | 1h');
            const hourMillis = 60 * 60 * 1000;
            const duration_hours = Math.round((stop.getTime() - start.getTime()) / hourMillis);
            if (duration_hours <= 0 || duration_hours > 9999)
                throw new Error(`Holiday duration must be in range 0-9999 hours in: ${new_state.holiday_start_stop}`);

            const res = [];
            res.push(start.getFullYear()-2000);
            res.push(start.getMonth()+1);
            res.push(start.getDate());
            res.push(start.getHours());
            res.push(start.getMinutes());
            res.push(Math.round(temperature * 2));
            res.push(duration_hours >> 8);
            res.push(duration_hours & 0xFF);

            await legacy.sendDataPointRaw(entity, dpHoliday, res); // 'sendData' does not make it to the device. 
            const ret = { 
                holiday_start_stop: `${format_dtYYYYMMDD_HHMM(start)} | ${format_dtYYYYMMDD_HHMM(stop)}`,
                holiday_temperature: temperature,
            };
            // holiday schedule is only taken when system_mode == 'off'. 
            // Could be done manually, but may be forgotten. Especially if holiday starts later.
            // So always setting it here if not done explicit. User can still revert it.
            if ((new_state.system_mode || 'auto') != 'off' && !msg.hasOwnProperty('system_mode')) {
                // if holiday schedule period is already over, then the device will set system_mode back to 'auto'
                await legacy.sendDataPointEnum(entity, dpSystemMode, thermostatSystemModesConverter.to('off'));
                ret.system_mode = 'off';
            }
            return { state: ret };
        },
    };
};

const thermostatScheduleDayMulti2 = {
    from: (v, meta) => {
        // [degree*2, hour*4, degree*2, ..., hour*4]
        const res = [];
        for(let i = 1; i < 15; i += 2) {
            const degree = (v[i] || 34) / 2;
            const hour = (v[i+1] || 96) >> 2;
            const min = ((v[i+1] || 0) & 0x3) * 15;
            const tm = `${String(hour).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
            res.push(`${tm}/${degree.toFixed(1)}°`);
        }
        return res.join(' ');
    },
    to: (v, meta) => {
        const numberPattern = /[\d.]+/g;
        const arr = v.match(numberPattern);
        const res = [0];
        if (arr.length > 7*3)
            throw new Error(`Too many holiday schedules (max=7) in ${v}`);
        for(let i = 0; i < arr.length; i += 3) {
            const hour = parseInt(arr[i+0]);
            const min = parseInt(arr[i+1]);
            const degree = parseFloat(arr[i+2]);
            if ( hour < 0 || hour > 24 || min < 0 || min >= 60 || degree <= 0 || degree >= 30 )
                throw new Error(`thermostatScheduleDayMulti2: hour, minute or degree out of range in ${v}`);
            res.push(Math.round(degree*2));
            res.push(hour*4 + Math.ceil(min/15));
        }
        while (res.length < 15)
            res.push(17*2, 24<<2);
        return res;
    },
};

const thermostatScheduleDayMultiWithDayNumber2 = (dayNum) => {
    return {
        from: (v, meta) => thermostatScheduleDayMulti2.from(v, meta),
        to: (v, meta) => {
            const data = thermostatScheduleDayMulti2.to(v, meta);
            data[0] = dayNum;
            return data;
        },
    };
};

const fromZigbeeTuyaWrap = (aggr_states, ...otherFromZigbee) => {
    // aggregate/calulate more states based on physical reported zigbee tuya states
    return {
        cluster: 'manuSpecificTuya',
        //type: ['commandDataResponse', 'commandDataReport'],
        type: ['commandDataResponse', 'commandDataReport', 'commandActiveStatusReport', 'commandActiveStatusReportAlt'],
        convert: (model, msg, publish, options, meta) => {
            const dpValue = legacy.firstDpValue(msg, meta, 'zigbee_tuya_wrap');
            const dp = dpValue.dp;
            const v = legacy.getDataValue(dpValue);
            meta.logger.debug(`fromZigbeeTuyaWrap.convert(${msg.type}[${dp}] = ${v})`);
            for (const frzi of otherFromZigbee) {
                if (!frzi.type.includes(msg.type))
                    continue;
                try {
                    const ret = frzi.convert(model, msg, publish, options, meta);
                    if (ret) {
                        const new_state = {...meta.state, ...ret};
                        const extra = aggr_states(new_state);
                        // only those from extra which differ
                        for (const [k, v] of Object.entries(extra))
                            if (!new_state.hasOwnProperty(k) || new_state[k] != v)
                                ret[k] = v;
                        return ret;
                    }
                }
                catch(e) {
                    meta.logger.error(`fromZigbeeTuyaWrap(${msg.type}[${dp}] = ${v}): ${e}`);
                }
            }
            meta.logger.warn(`fromZigbeeTuyaWrap: fz.convert handler found for ${msg.type}[${dp}] = ${v}`);
        },
    };
};

const toZigbeeWrap = (aggr_states, ...otherToZigbee) => {
    return {
        key: Array.from(new Set(Array.prototype.concat.apply([], otherToZigbee.map((e) => e.key)))),
        convertSet: async (entity, key, value, meta) => { 
            meta.logger.debug(`toZigbeeWrap.convertSet(${key} = ${value})`);
            let ret = null;
            for (const tozi of otherToZigbee) {
                if (tozi.key.includes(key)) {
                    try {
                        ret = tozi.convertSet(entity, key, value, meta);
                        if (ret)
                            break;
                    }
                    catch(e) {
                        meta.logger.error(`toZigbeeWrap(${key}=${value}): ${e}`);
                    }
                }
            }
            ret = ret || { state: {} };
            if (!ret.hasOwnProperty('state'))
                ret.state = {};
            meta.logger.debug(`toZigbeeWrap.convertSet(${key} = ${value} => ${JSON.stringify(ret)})`);
            const msg = meta.message || {};
            const new_state = {...meta.state, ...msg, ...ret.state};
            Object.assign(ret.state, aggr_states(new_state));
            return ret;
        },
    };
};

const device = {
    fingerprint: [
        {modelID: 'TS0601', manufacturerName: '_TZE200_uiyqstza'},
    ],
    model: '368308_2010_2',
    vendor: 'Lidl',
    description: 'Essentials radiator valve with thermostat (ESS-HK-TRV-6202, ESS-HK-TRV-6202-02)',
    /*
    whiteLabel: [
        tuya.whitelabel('Essentials', 'ESS-HK-TRV-6202', 'Thermostatic radiator valve', ['_TZE200_uiyqstza']),    
        tuya.whitelabel('Essentials', 'ESS-HK-TRV-6202-02', 'Thermostatic radiator valve', ['_TZE200_uiyqstza']),    
    ],
    */
    fromZigbee: [
        legacy.fz.tuya_data_point_dump, // This is a debug converter
        fromZigbeeTuyaWrap(calc_preset_valve_state,
            fromZigbeeHoliday(legacy.dataPoints.zsAwaySetting),
            tuya.fz.datapoints
        ),
    ],
    toZigbee: [
        toZigbeePreset(legacy.dataPoints.zsMode, legacy.dataPoints.zsHeatingSetpoint, dataPoints.zsBoostHeating),
        toZigbeeWrap(calc_preset_valve_state,
            toZigbeeHoliday(legacy.dataPoints.zsAwaySetting, legacy.dataPoints.zsMode),
            legacy.tz.zs_thermostat_current_heating_setpoint_auto, // not in tuya yet
            legacy.tz.zs_thermostat_openwindow_temp, // not in tuya yet
            legacy.tz.zs_thermostat_openwindow_time, // not in tuya yet
            tuya.tz.datapoints
        ),
    ],
    onEvent: tuya.onEventSetLocalTime,
    configure: async (device, coordinatorEndpoint, logger) => {
        await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
        // copied from lidl.js
        const endpoint = device.getEndpoint(1);
        await reporting.bind(endpoint, coordinatorEndpoint, ['genBasic']);
    },
    meta: {
        tuyaDatapoints: [
            [30, 'child_lock', tuya.valueConverter.lockUnlock], // 0: unlocked, 1: locked

            [2, 'system_mode', thermostatSystemModesConverter],

            [16, 'current_heating_setpoint', tuya.valueConverterBasic.divideBy(2)],
            [105, 'current_heating_setpoint_auto', tuya.valueConverterBasic.divideBy(2)], // not in tuya.datapoints.key
            [104, 'local_temperature_calibration', tuya.valueConverter.localTempCalibration1],
            [24, 'local_temperature', tuya.valueConverter.divideBy10],

            [101, 'comfort_temperature', tuya.valueConverterBasic.divideBy(2)],
            [102, 'eco_temperature', tuya.valueConverterBasic.divideBy(2)],

            [107, 'window', tuya.valueConverterBasic.lookup({'OPEN': true, 'CLOSED': false})],  // not in tuya.datapoints.key
            [116, 'detectwindow_temperature', tuya.valueConverterBasic.divideBy(2)], // not in tuya.datapoints.key
            [117, 'detectwindow_timeminute', tuya.valueConverter.raw], // not in tuya.datapoints.key
 
            [118, 'boost_timeset_countdown', tuya.valueConverter.countdown], // seconds
            [106, 'boost_heating', tuya.valueConverter.onOff],

            [109, 'schedule_monday', thermostatScheduleDayMultiWithDayNumber2(1)],
            [110, 'schedule_tuesday', thermostatScheduleDayMultiWithDayNumber2(2)],
            [111, 'schedule_wednesday', thermostatScheduleDayMultiWithDayNumber2(3)],
            [112, 'schedule_thursday', thermostatScheduleDayMultiWithDayNumber2(4)],
            [113, 'schedule_friday', thermostatScheduleDayMultiWithDayNumber2(5)],
            [114, 'schedule_saturday', thermostatScheduleDayMultiWithDayNumber2(6)],
            [115, 'schedule_sunday', thermostatScheduleDayMultiWithDayNumber2(7)],

            // Hm!!! not in tuya, but works for some reason
            [34, 'battery', tuya.valueConverterBasic.scale(0, 100, 0, 150)],
        ]
    },
    exposes: [
        e.child_lock(), 
        e.comfort_temperature().withValueStep(0.5), e.eco_temperature().withValueStep(0.5), 
        e.numeric('holiday_temperature', ea.STATE_SET).withDescription('Temperature for holiday')
            .withValueMin(0.5).withValueMax(29.5).withValueStep(0.5).withUnit('°C'),
        e.numeric('current_heating_setpoint_auto', ea.STATE_SET).withValueMin(0.5).withValueMax(29.5)
            .withValueStep(0.5).withUnit('°C').withDescription('Current temperature setpoint for automatic weekday schedule'),
        e.climate().withSetpoint('current_heating_setpoint', 0.5, 29.5, 0.5, ea.STATE_SET)
            .withLocalTemperature(ea.STATE)
            .withLocalTemperatureCalibration(-5.5, 5.5, 0.1, ea.STATE_SET)
            .withSystemMode(['auto', 'heat', 'off'], ea.STATE_SET, 'Mode (auto=schedule, heat=manual, off=holiday)')
            .withPreset(Object.values(thermostatPresets), 'Temperature/mode presets. summer_mode: valve is fully open but scale protected, frost_protection: fixed minimum temperature: 5°C'),
        //e.binary('away_mode', ea.STATE, 'ON', 'OFF').withDescription('Holiday/Away mode'), // can not be set. Only via holiday start/stop

        e.valve_state(),

        e.binary('window', ea.STATE, 'OPEN', 'CLOSED').withDescription('Window status'),
        e.numeric('detectwindow_temperature', ea.STATE_SET).withValueMin(0.5).withValueMax(29.5).withValueStep(0.5).withUnit('°C')
            .withDescription('Open Window Detection Temperature'),
        e.numeric('detectwindow_timeminute', ea.STATE_SET).withUnit('min').withDescription('Open Window Time. Zero for no detection')
            .withValueMin(0).withValueMax(60),

        e.binary('boost_heating', ea.STATE_SET, 'ON', 'OFF').withDescription('Boost Heating'),
        e.numeric('boost_timeset_countdown', ea.STATE_SET).withValueMin(0).withValueMax(900).withUnit('secs')
            .withDescription('Boost count down'), // fixed to 15 mins

        e.text('holiday_start_stop', ea.STATE_SET).withDescription('Start and stop date and time of holiday (format: YYYY-MM-DD HH:MM | YYYY-MM-DD HH[MM])'),
        
        ...tuya.exposes.scheduleAllDays(ea.STATE_SET, 'HH:MM/°C HH:MM/°C ...'),

        e.battery(),
    ],
};

module.exports = device;