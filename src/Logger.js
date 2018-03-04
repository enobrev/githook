    "use strict";

    const winston = require('winston');
    const Syslog  = require('winston-syslog').Syslog; // This has to be here or winston shits the bed on init

    const objectFromPath = function (oObject, sPath, mValue) {
        sPath.split('.').reduce((oValue, sKey, iIndex, aSplit) => oValue[sKey] = iIndex === aSplit.length - 1 ? mValue : {}, oObject);
    };

    const syslogFormatter = function (oOptions) {
        return '@cee: ' + JSON.stringify(oOptions.meta, (sKey, mValue) => {
                return mValue instanceof Buffer
                    ? mValue.toString('base64')
                    : mValue;
            });
    };

    const indexedLogRewriter = (sLevel, sMessage, oMeta) => {
        let oOutput = {};

        if (oMeta.action) {
            const sAction = oMeta.action;
            delete oMeta.action;

            oOutput['--action'] = sAction;

            // Move all "--*" items to root
            Object.keys(oMeta).map(sKey => {
                if (sKey.indexOf('--') === 0) {
                    oOutput[sKey] = oMeta[sKey];
                    delete oMeta[sKey];
                }
            });

            if (Object.keys(oMeta).length > 0) {
                objectFromPath(oOutput, sAction, oMeta);
            }
        }

        return oOutput;
    };

    const oTransportConsole = new (winston.transports.Console)({
        app_name:  'githook-server',
        timestamp: true,
        colorize:  true,
        json:      true,
        level:     'debug'
    });

    const oTransportSyslog = new (winston.transports.Syslog)({
        app_name:  'githook-server',
        localhost: null, // Keep localhost out of syslog messages
        protocol:  'unix-connect',
        path:      '/dev/log',
        formatter: syslogFormatter
    });

    let aTransports = [];
    aTransports.push(oTransportSyslog);
    //aTransports.push(oTransportConsole);

    const LOG = new winston.Logger({
        level:      'debug',
        transports: aTransports
    }).setLevels(winston.config.syslog.levels);

    LOG.rewriters.push(indexedLogRewriter);

    module.exports = LOG;