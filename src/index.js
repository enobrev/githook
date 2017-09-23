"use strict";

    const os     = require('os');
    const fs     = require('fs');
    const http   = require('http');
    const exec   = require('child_process').exec;
    const Slack  = require('slack-node');
    const LOG    = require('./Logger');
    const CONFIG = require('../.config.json');

    let oSlack = new Slack();
    oSlack.setWebhook(CONFIG.slack.webhook);

    let handleHTTPRequest = function(oRequest, oResponse) {
        let oHeaders = oRequest.headers;
        let sMethod  = oRequest.method;
        let sUrl     = oRequest.url;
        let aBody    = [];

        if (oHeaders && oHeaders['x-github-event'] === 'push') {
            LOG.debug({action: 'githook.build.request', delivery: oHeaders['x-github-delivery'], method: sMethod, url: sUrl});

            oRequest.on('error', oError => {
                LOG.error({action: 'githook.build.request.error', error: {
                    name:    oError.name,
                    message: oError.message
                }});
            });

            oRequest.on('data', sChunk => {
                aBody.push(sChunk);
            });

            oRequest.on('end', () => {
                let sBody;
                let oBody;
                try {
                    sBody = Buffer.concat(aBody).toString();
                    oBody = JSON.parse(sBody);

                    LOG.info({
                        action:     'githook.build.start',
                        sender:     oBody.sender.login,
                        repository: oBody.repository.full_name,
                        commit:     oBody.head_commit.id,
                        message:    oBody.head_commit.message,
                        body:       oBody
                    });

                    oSlack.webhook({
                        text: `I started a Build for repo <${oBody.repository.html_url}|${oBody.repository.full_name}>, commit <${oBody.head_commit.url}|${oBody.head_commit.id}> by *${oBody.sender.login}* with message: ${oBody.head_commit.message}`
                    }, (err, response) => {});
                } catch (e) {
                    LOG.warning({
                        action:     'githook.build.start',
                        error:      {
                            name:    e.name,
                            message: e.message
                        }
                    });
                }

                const sPath = CONFIG.builds[oBody.repository.full_name];

                if (!sPath) {
                    LOG.warn({
                        action:     'githook.build.repository.not_defined',
                        repository: oBody.repository.full_name,
                    });

                    return;
                }

                const sCommand = `cd ${sPath} && make githook`;

                LOG.info({
                    action:     'githook.build.command',
                    command:     sCommand
                });


                exec(sCommand, // command line argument directly in string
                    (error, stdout, stderr) => {      // one easy function to capture data/errors
                        let sFile = ['/tmp/githook', oBody.head_commit.id].join('-');

                        if (stderr) {
                            let aErrors = stderr.split("\n");
                            for (let i = aErrors.length - 1; i >= 0; i--) {
                                const sError = aErrors[i].toLowerCase().trim();
                                if (sError.length === 0
                                ||  sError.indexOf('warning') > -1
                                ||  sError.indexOf('parsequery') > -1) {
                                    aErrors.splice(i, 1);
                                }
                            }

                            stderr = aErrors.length > 0 ? aErrors.join("\n") : null;
                        }

                        if (stderr) {
                            fs.writeFileSync(sFile + '-err', stderr);

                            LOG.error({action: 'githook.build.std.error', log_file: sFile, output: stderr.split("\n")});
                            oSlack.webhook({
                                text: `I just finished a Build for repo <${oBody.repository.html_url}|${oBody.repository.full_name}>, commit <${oBody.head_commit.url}|${oBody.head_commit.id}>, but there _may_ be errors.  Check: ${sFile}-err`
                            }, (err, response) => { });
                        } else if (error) {
                            LOG.error({action: 'githook.build.exec.error', output: error});

                            oSlack.webhook({
                                text:     `I failed a Build for repo <${oBody.repository.html_url}|${oBody.repository.full_name}>, commit <${oBody.head_commit.url}|${oBody.head_commit.id}>.  Error was: ${error.message}`
                            }, (err, response) => {});
                        } else {
                            fs.writeFileSync(sFile + '-ok', stdout);

                            LOG.info({
                                action:     'githook.build.done',
                                sender:     oBody.sender.login,
                                repository: oBody.repository.full_name,
                                commit:     oBody.head_commit.id,
                                message:    oBody.head_commit.message,
                                log_file:   sFile
                            });

                            oSlack.webhook({
                                text:     `I finished a Build for repo <${oBody.repository.html_url}|${oBody.repository.full_name}>, commit <${oBody.head_commit.url}|${oBody.head_commit.id}> by *${oBody.sender.login}* with message: ${oBody.head_commit.message}`
                            }, (err, response) => {});
                        }

                    });
            });
        } else if (oHeaders && oHeaders['x-github-event'] === 'ping') {
            LOG.info({action: 'githook.build.request.ping', method: sMethod, url: sUrl});
        } else if (sUrl === '/') {
            oResponse.writeHead(200, {'Content-Type': 'text/plain'});
            oResponse.write('ARRRG');
            oResponse.end();
            return;
        } else {
            LOG.warning({action: 'githook.build.request.weird', method: sMethod, url: sUrl});
        }

        oResponse.writeHead(202, {'Content-Type': 'text/plain'});
        oResponse.end();
    };

    http.createServer(handleHTTPRequest).listen(CONFIG.server.port);

    let ping = () => {
        LOG.info({
            action:    'githook.ping',
            hostname:   os.hostname(),
            pid:        process.pid,
            port:       CONFIG.server.port
        });
    };

    ping();
    setInterval(ping, CONFIG.server.ping);

    LOG.notice({action: 'githook.init'});

    oSlack.webhook({
        text:  "Hello! I'm here and waiting for github updates."
    }, (err, response) => {});
