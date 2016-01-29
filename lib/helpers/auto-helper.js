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
  detect: function () {
    if (!DataTypes) {
      DataTypes = require(path.resolve(helpers.generic.getSequelizePath(), '../', 'lib', 'data-types'));
    }
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
          return compareSchemas(qi, dbmodels, sequelizer.models)
                    .then(generateAutoMigrations);
        });

      return allTables;
    } catch (e) {
      console.error(e);
    }
  }
};

function getModelConfig () {
  var config = path.resolve(process.cwd(), 'config', 'models.json');
  return require(config);
}

function compareSchemas (qi, dbmodels, schemamodels) {
  return getSchemas(qi, dbmodels, schemamodels)
    .then(compareDB)
    .then(compareSequelizer)
    .then(function (schemas) {
      var sql = schemas.sequelizer, db = schemas.database;
      var queries = QueryBuilderFactory.getAllBuilders();
      return queries;
    });
}

function generateAutoMigrations (queryBuilders) {
  _.each(queryBuilders, function (queryBuilder) {
    
    var file = getAutoMigrationPath(queryBuilder.tableName);
    var content = generateAutoMigrationContent(queryBuilder.getQueries());
    return helpers.asset.write(file, content);
  });
}

function getAutoMigrationPath (tableName) {
  var file = [tableName, "auto", "0001"].join("-");
  file = helpers.path.getFileName('migration', file);
  return path.resolve(helpers.path.getPath('migration'), file);
}

function generateAutoMigrationContent (query) {
  return helpers.template.render('migrations/auto-migrate.js', {
    query: query
  });
}

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


function getSchemas (qi, dbmodels, schemamodels) {

  var schemaPromises = {}, dbPromises = {};

  _.forEach(schemamodels, function (model) {
    schemaPromises[model.getTableName().toLowerCase()] = model.rawAttributes;
  });
  _.forEach(dbmodels, function (model) {
    dbPromises[model.toLowerCase()] = qi.describeTable(model);
  });

  var allSchema = Bluebird.props(schemaPromises);
  var allDb = Bluebird.props(dbPromises);

  return Bluebird.props({
    sequelizer: allSchema,
    database: allDb
  });
}


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

function QueryBuilder (tableName) {
  this.tableName = tableName;
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
