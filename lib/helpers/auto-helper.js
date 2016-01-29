'use strict';

var fs   = require('fs-extra');
var path = require('path');
var helpers = require(__dirname);
var Bluebird = require("bluebird");
var _ = require("lodash");
var DataTypes;
var yargs = require('yargs').argv;


var FIELD_OPTIONS = [
  'allowNull',
  'defaultValue',
  'unique',
  'primaryKey',
  'autoIncrement',
  'comment',
  'onUpdate',
  'onDelete'
];

module.exports = {
  /**
   * Entry point to detect changes. Returns a promise
   */
  generate: function () {
    try {
      var sequelizer = helpers.db.getSequelizeInstance();
      var config = getModelConfig();
      
      if (!config.models || config.models.length === 0) {
        console.log("No models found in configuration");
        return Bluebird.resolve();
      }

      var models = {};

      config.models.forEach(function (model) {
        var modelpath = path.resolve(process.cwd(), model);
        var curModel = sequelizer.import(modelpath);
      });

      var qi = sequelizer.getQueryInterface();
      var allTables = qi.showAllTables()
        .then(function (results) {
          var dbmodels = {};
          results.forEach(function (result) {
            if (result.toLowerCase() === "sequelizemeta") {
              return;
            }
            dbmodels[result] = result;
            return;
          });
          return compareSchemas({qi: qi, 
                                 databaseModels: dbmodels, 
                                 sequelizerModels: sequelizer.models,
                                 sequelizer: sequelizer })
                    .then(generateAutoMigrations);
        });

      return allTables;
    } catch (e) {
      console.error(e);
    }
  }
};

/*
 * getModelConfig
 *
 * Looks for a file, 'models.json', in the config directory
 */
function getModelConfig () {
  var config = path.resolve(process.cwd(), 'config', 'models.json');
  return require(config);
}

/*
 * @param {Object} args - Argument object
 * @param {QueryInterface} args.qi - A reference to the current sequelizer.queryInterface
 * @param {string[]} args.databaseModels - An array of existing database table names
 * @param {Model[]} args.sequelizerModels - An array of the registered sequelizer.models
 * @param {Sequelizer} args.sequelizer - A reference to the current sequelizer
 * 
 * @returns {Promise} A promise containing input args, and args.queryBuilders - an array of QueryBuilder instances 
 *
 * This compares the actual database to the registered models in sequelizer and builds queries to sync the states
 */
function compareSchemas (args) {
  return getSchemas(args.qi, args.databaseModels, args.sequelizerModels)
    .then(compareDB)
    .then(compareSequelizer)
    .then(function () {
      var queries = QueryBuilderFactory.getAllBuilders();
      args.queryBuilders = queries;
      return args;
    });
}

/*
 * @returns {Promise} fullfilled when received a reference to the migrator
 */
function getMigrator () {
  return new Bluebird.Promise(function (resolve, reject) {
    return helpers.db.getMigrator('migration', resolve);
  });
}

/*
 * @param {Object} args - Argument object
 * @param {QueryBuilder[]} args.queryBuilders - An array of the pending queries to run
 *
 * @returns {Promise} fullfilled with a list of all executed migrations
 */
function getLatestAutoMigrations (args) {
  var executed = getMigrator().then(function (migrator) {
    return migrator.executed();
  });

  executed.then(function (migrations) {
    _.each(args.queryBuilders, function (queryBuilder) {
      queryBuilder.updateLatestMigration(migrations);
    });
  });

  return executed;
}

/*
 * @param {Object} args - Argument object
 * @param {QueryBuilder[]} args.queryBuilders - An array of the pending queries to run
 * 
 * @returns {Promise} fullfilled when migrations have been written to disk
 *
 * Given a list of queryBuilders, this pulls the latest applied migrations from the database,
 * removes from the migrations folder any unmigrated migrations, and generates a new migration
 * file, one per model/querybuilder. 
 */
function generateAutoMigrations (args) {
  var latest = getLatestAutoMigrations(args);

  latest.then(function () {
    _.each(args.queryBuilders, function (queryBuilder) {
      cleanUnsavedVersions(queryBuilder.tableName, queryBuilder.nextVersion);
      var file = getAutoMigrationPath(queryBuilder.tableName, queryBuilder.nextVersion);
      var content = generateAutoMigrationContent(queryBuilder.getQueries());
      console.log("Writing", file);
      return helpers.asset.write(file, content);
    });
  });
  return latest;
}

/*
 * @param {string} tableName - name of the table to look for migration files
 * @param {string} nextVers - the next version of the migration
 *
 * This scans the migrations directory and deletes any migrations that are equal
 * to or higher than the nextVers
 */
function cleanUnsavedVersions (tableName, nextVers) {
  var migDir = helpers.path.getPath('migration');
  var allMigrations = fs.readdirSync(migDir);
  allMigrations = allMigrations.filter(function (mig) {
    return mig.indexOf("-" + tableName + "-auto-") >= 0;
  }).filter(function (mig) {
    var fileVers = mig.substr(mig.length - 7, 4);
    if (parseInt(fileVers, 10) >= parseInt(nextVers, 10)) {
      return mig;
    }
  });
  allMigrations.forEach(function (mig) {
    var migPath = path.resolve(migDir, mig);
    console.log("Removing unsaved", migPath);
    fs.unlinkSync(migPath);
  });
}

function getAutoMigrationFileName (tableName, version) {
  var file = [tableName, "auto", version].join("-");
  return helpers.path.getFileName('migration', file);
}
function getAutoMigrationPath (tableName, version) {
  var file = getAutoMigrationFileName(tableName, version);
  return path.resolve(helpers.path.getPath('migration'), file);
}

function generateAutoMigrationContent (query) {
  return helpers.template.render('migrations/auto-migrate.js', {
    query: query
  });
}

/*
 * @param {Object} schemas - Object containing schema references
 * @param {Object} schemas.database - Object containing keys for every model in the database. Each model also contains objects for all model columns
 * @param {Object} schemas.sequelizer - Object containing keys for every model registered with sequelizer. 
 *
 * @returns {Promise} fullfilled when comparison is done
 *
 * This runs through all database models, and looks for differences between the database and sequelizer.
 * Any columns found in the database but not in sequelizer will generate "dropColumn" statements
 * Any tables found in the database but not in sequelizer will print a warning, unless the "--drop" flag was used,
 *   in which case it will generate a "dropTable" statement
 */
function compareDB (schemas) {

  var db = schemas.database, sql = schemas.sequelizer;
  _.each(db, function (dbModel, dbTableName) {

    var queryBuilder = QueryBuilderFactory.getQueryBuilder(dbTableName);

    if (!(dbTableName in sql)) {
      console.warn("WARNING: Database contains table '" + dbTableName + "' but it does not appear in your Sequelizer models.json.");
      if (yargs.drop) {
        console.warn("WARNING: Ran with '--drop'. Generating migration to DROP '" + dbTableName + "'.");
        queryBuilder.dropTable();
      }
      return;
    }
    var sqlModel = sql[dbTableName];

    _.each(dbModel, function (dbColumn, dbColumnName) {
      if (!(dbColumnName in sqlModel)) {
        queryBuilder.removeColumn(dbColumnName);
        return;
      }
    });
  });

  return schemas;
}

/*
 * @param {Object} schemas - Object containing schema references
 * @param {Object} schemas.database - Object containing keys for every model in the database. Each model also contains objects for all model columns
 * @param {Object} schemas.sequelizer - Object containing keys for every model registered with sequelizer. 
 *
 * @returns {Promise} fullfilled when comparison is done
 *
 * This runs through all sequelizer models, and looks for differences between sequelizer and the database.
 * Any columns found in sequelizer but not in the database will generate "addColumn" statements
 * Any tables found in sequelizer but not in the database will do nothing. It is assumed that sequelizer.Sync() will take care of those.
 */
function compareSequelizer (schemas) {

  var db = schemas.database, sqlz = schemas.sequelizer;
  _.each(sqlz, function (sqlzModel, sqlzModelName) {
    var queryBuilder = QueryBuilderFactory.getQueryBuilder(sqlzModelName);

    if (!(sqlzModelName in db)) {
      queryBuilder.addTable(sqlzModelName, sqlzModel);
      return;
    }

    var dbModel = db[sqlzModelName];

    _.each(sqlzModel, function (sqlzField, sqlzFieldName) {
      if (!(sqlzFieldName in dbModel)) {
        queryBuilder.addColumn(sqlzFieldName, sqlzField);
        return;
      }
    });
  });

  return schemas;
}

/*
 * @param {QueryInterface} qi - A reference to the current sequelizer.queryInterface
 * @param {string[]} dbmodels - A list of database model names
 * @param {Model[]} sequelizerModels - A list of sequelizer models
 *
 * @returns {Promise} fullfilled when column names of each schema have been populated
 *
 * This fills in all columns and properties for both sequelizer models and database models
 */
function getSchemas (qi, dbmodels, sequelizerModels) {

  var sequelizerPromises = {}, dbPromises = {};

  _.forEach(sequelizerModels, function (model) {
    sequelizerPromises[model.getTableName().toLowerCase()] = model.rawAttributes;
  });
  _.forEach(dbmodels, function (model) {
    dbPromises[model.toLowerCase()] = qi.describeTable(model);
  });

  var allSchema = Bluebird.props(sequelizerPromises);
  var allDb = Bluebird.props(dbPromises);

  return Bluebird.props({
    sequelizer: allSchema,
    database: allDb
  });
}


/*
 * QueryBuilderFactory
 * 
 * Stores and returns a single instance of a QueryBuilder per model
 */
var QueryBuilderFactory = {
  builders : {},
  getQueryBuilder: function (tableName) {
    if (this.builders.hasOwnProperty(tableName)) {
      return this.builders[tableName];
    };
    this.builders[tableName] = new QueryBuilder(tableName);
    return this.builders[tableName];
  },
  getAllBuilders: function () {
    return this.builders;
  }
}

/*
 * @class QueryBuilder
 *
 * This class is used to fill in the necessary statements needed for 'up' and 'down' migrations
 */
function QueryBuilder (tableName) {
  this.tableName = tableName;
  this.latestVersion = "0001";
  this.up = [];
  this.down = [];
}

QueryBuilder.prototype.addColumn = function (fieldName, field) {
  this.up.push(this._addColumnQuery(fieldName, field));
  this.down.push(this._removeColumnQuery(fieldName));
}
QueryBuilder.prototype._addColumnQuery = function (fieldName, field) {
  var options = {
    type: field.type.toSql()
  };
  FIELD_OPTIONS.forEach(function (option) {
    if (field.hasOwnProperty(option)) {
      options[option] = field[option];
    }
  });

  var query = `\n.addColumn('${this.tableName}', '${fieldName}', ${JSON.stringify(options, null, 2)})`;
  return query;
}

QueryBuilder.prototype.removeColumn = function (fieldName) {
  this.up.push(this._removeColumnQuery(fieldName));
}
QueryBuilder.prototype._removeColumnQuery = function (fieldName) {
  var query = `\n.removeColumn('${this.tableName}', '${fieldName}')`;
  return query;
}


QueryBuilder.prototype.dropTable = function () {
  this.up.push(this._dropTableQuery()); 
}
QueryBuilder.prototype._dropTableQuery = function () {
  var query = `\n.dropTable('${this.tableName}')`;
  return query;
}

QueryBuilder.prototype.addTable = function (modelName, attributes) {

}
QueryBuilder.prototype._addTableQuery = function (modelName, attributes) {

}

QueryBuilder.prototype.getQueries = function () {
  return {
    up: this.up,
    down: this.down
  };
}

QueryBuilder.prototype.updateLatestMigration = function (migrations) {
  var self = this;
  self.latestVersion = "0000";
  self.nextVersion = "0001";
  migrations = migrations.filter(function (migration) {
    return migration.file.indexOf("-" + self.tableName + "-auto-") >= 0;
  }).map(function (migration) {
    return migration.file.substr(migration.file.length - 7, 4);
  }).sort();

  if (migrations.length) {
    self.latestVersion = migrations[migrations.length - 1] ;
    self.nextVersion = pad(parseInt(self.latestVersion, 10) + 1);  
  }
}

function pad (num) {
  num = num + "";
  while (num.length < 4) {
    num = "0" + num;
  }
  return num;
}
