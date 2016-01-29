var path      = require('path');
var helpers   = require(__dirname);
var _         = require('lodash');
var url       = require('url');




module.exports = {
  getSequelizeInstance: getSequelizeInstance
};

function getSequelizeInstance () {
  var Sequelize = helpers.generic.getSequelize();
  var config  = null;
  var options = {};

  try {
    config = helpers.config.readConfig();
  } catch (e) {
    console.log(e.message);
    process.exit(1);
  }

  _.forEach(config, function (value, key) {
    if (['database', 'username', 'password'].indexOf(key) === -1) {
      options[key] = value;
    }

    if (key === 'use_env_variable') {
      if (process.env[value]) {
        var dbUrl = url.parse(process.env[value]);
        var protocol = dbUrl.protocol.split(':')[0];

        config.database = dbUrl.pathname.substring(1);

        if (protocol === 'sqlite') {
          options.storage = dbUrl.pathname;
        } else if (dbUrl.auth) {
          var auth = dbUrl.auth.split(':');

          config.username = auth[0];
          config.password = auth[1];
        }

        options = _.assign(options, {
          host: dbUrl.hostname,
          port: dbUrl.port,
          dialect: protocol,
          protocol: protocol
        });
      }
    }

    if (key === 'dialectOptions') {
      options = _.assign(options, {
        dialectOptions: value
      });
    }
  });

  options = _.assign({ logging: logMigrator }, options);

  try {
    return new Sequelize(config.database, config.username, config.password, options);
  } catch (e) {
    console.warn(e);
    throw e;
  }
}

function logMigrator (s) {
  if (s.indexOf('Executing') !== 0) {
    helpers.view.log(s);
  }
}