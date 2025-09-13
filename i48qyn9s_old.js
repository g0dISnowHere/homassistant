const fz = require('zigbee-herdsman-converters/converters/fromZigbee');
const tz = require('zigbee-herdsman-converters/converters/toZigbee');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const reporting = require('zigbee-herdsman-converters/lib/reporting');
const extend = require('zigbee-herdsman-converters/lib/extend');
const e = exposes.presets;
const ea = exposes.access;
const tuya = require('zigbee-herdsman-converters/lib/tuya');

const definition = {
    // Since a lot of TuYa devices use the same modelID, but use different datapoints
    // it's necessary to provide a fingerprint instead of a zigbeeModel
    fingerprint: [
        {
            // The model ID from: Device with modelID 'TS0601' is not supported
            // You may need to add \u0000 at the end of the name in some cases
            modelID: 'TS0601',
            // The manufacturer name from: Device with modelID 'TS0601' is not supported.
            manufacturerName: '_TZE200_i48qyn9s',
        },
    ],
    model: 'TS0601_new',
    vendor: 'TuYa',
    description: 'Thermostat radiator valve',
    fromZigbee: [tuya.fz.datapoints],
    toZigbee: [tuya.tz.datapoints],
    onEvent: tuya.onEventSetTime, // Add this if you are getting no converter for 'commandMcuSyncTime'
    configure: tuya.configureMagicPacket,
    exposes: [
        e.battery(), e.child_lock(),
        e.max_temperature().withValueMin(15).withValueMax(45),
        e.min_temperature().withValueMin(5).withValueMax(15),
        e.window_detection(),
        e.open_window_temperature().withValueMin(5).withValueMax(25),
        e.comfort_temperature().withValueMin(5).withValueMax(35),
        e.eco_temperature().withValueMin(5).withValueMax(35),
        e.holiday_temperature().withValueMin(5).withValueMax(35),
        e.climate().withPreset(['auto', 'manual', 'holiday', 'comfort']).withLocalTemperatureCalibration(-9, 9, 0.1, ea.STATE_SET)
            .withLocalTemperature(ea.STATE).withSetpoint('current_heating_setpoint', 5, 30, 0.5, ea.STATE_SET)
            .withSystemMode(['off', 'heat'], ea.STATE_SET, 'Only for Homeassistant')
            .withRunningState(['idle', 'heat'], ea.STATE_SET),
        tuya.exposes.frostProtection('When Anti-Freezing function is activated, the temperature in the house is kept '+
                'at 8 °C, the device display "AF".press the pair button to cancel.'),
        e.numeric('boost_timeset_countdown', ea.STATE_SET).withUnit('s').withDescription('Setting '+
                'minimum 0 - maximum 465 seconds boost time. The boost function is activated. The remaining '+
                'time for the function will be counted down in seconds ( 465 to 0 ).').withValueMin(0).withValueMax(465),
        e.composite('schedule', 'schedule', ea.STATE_SET).withFeature(e.enum('week_day', ea.SET, ['monday', 'tuesday',
            'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])).withFeature(e.text('schedule', ea.SET))
            .withDescription('Schedule will work with "auto" preset. In this mode, the device executes ' +
            'a preset week programming temperature time and temperature. Before using these properties, check `working_day` ' +
            'property. Each day can contain up to 10 segments. At least 1 segment should be defined. Different count of segments ' +
            'can be defined for each day, e.g., 3 segments for Monday, 5 segments for Thursday, etc. It should be defined in the ' +
            'following format: `hours:minutes/temperature`. Minutes can be only tens, i.e., 00, 10, 20, 30, 40, 50. Segments should ' +
            'be divided by space symbol. Each day should end with the last segment of 24:00. Examples: `04:00/20 08:30/22 10:10/18 ' +
            '18:40/24 22:50/19.5`; `06:00/21.5 17:20/26 24:00/18`. The temperature will be set from the beginning/start of one ' +
            'period and until the next period, e.g., `04:00/20 24:00/22` means that from 00:00 to 04:00 temperature will be 20 ' +
            'degrees and from 04:00 to 00:00 temperature will be 22 degrees.'),
        ...tuya.exposes.scheduleAllDays(ea.STATE, 'HH:MM/C'),
        e.binary('valve', ea.STATE, 'CLOSED', 'OPEN'),
        e.enum('factory_reset', ea.STATE_SET, ['SET']).withDescription('Remove limits'),
        tuya.exposes.errorStatus(),
        // Here you should put all functionality that your device exposes
    ],
    meta: {
        // All datapoints go in here
        tuyaDatapoints: [
            [49, 'running_state', tuya.valueConverterBasic.lookup({'heat': tuya.enum(1), 'idle': tuya.enum(0)})],
            [49, 'system_mode', tuya.valueConverterBasic.lookup({'heat': tuya.enum(1), 'off': tuya.enum(0)})],
            [2, 'preset', tuya.valueConverterBasic.lookup({'comfort': tuya.enum(3), 'auto': tuya.enum(0),
                'manual': tuya.enum(2), 'holiday': tuya.enum(1)})],
            [4, 'current_heating_setpoint', tuya.valueConverter.divideBy10],
            [5, 'local_temperature', tuya.valueConverter.divideBy10],
            [6, 'battery', tuya.valueConverter.raw],
            [7, 'child_lock', tuya.valueConverter.lockUnlock],
            [9, 'max_temperature_limit', tuya.valueConverter.divideBy10],
            [10, 'min_temperature_limit', tuya.valueConverter.divideBy10],
            [14, 'window_detection', tuya.valueConverter.onOff],
            [16, 'open_window_temperature', tuya.valueConverter.divideBy10],
            [17, 'open_window_time', tuya.valueConverter.raw],
            [18, 'backlight', tuya.valueConverter.raw],
            [19, 'factory_reset', tuya.valueConverter.setLimit],
            [21, 'holiday_temperature', tuya.valueConverter.raw],
            [24, 'comfort_temperature', tuya.valueConverter.divideBy10],
            [25, 'eco_temperature', tuya.valueConverter.divideBy10],
            [28, 'schedule_monday', tuya.valueConverter.thermostatScheduleDayMultiDP],
            [29, 'schedule_tuesday', tuya.valueConverter.thermostatScheduleDayMultiDP],
            [30, 'schedule_wednesday', tuya.valueConverter.thermostatScheduleDayMultiDP],
            [31, 'schedule_thursday', tuya.valueConverter.thermostatScheduleDayMultiDP],
            [32, 'schedule_friday', tuya.valueConverter.thermostatScheduleDayMultiDP],
            [33, 'schedule_saturday', tuya.valueConverter.thermostatScheduleDayMultiDP],
            [34, 'schedule_sunday', tuya.valueConverter.thermostatScheduleDayMultiDP],
            [35, 'error_status', tuya.valueConverter.raw],
            [36, 'frost_protection', tuya.valueConverter.onOff],
            [37, 'boost_heating', tuya.valueConverter.onOff],
            [38, 'boost_time', tuya.valueConverter.countdown],
            [39, 'Switch Scale', tuya.valueConverter.raw],
            [47, 'local_temperature_calibration', tuya.valueConverter.localTempCalibration1],
            [48, 'valve_testing', tuya.valueConverter.raw],
            [49, 'valve', tuya.valueConverterBasic.lookup({'OPEN': 1, 'CLOSE': 0})],
        ],
    },
};

module.exports = definition;