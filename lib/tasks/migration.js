'use strict';

var path      = require('path');
var helpers   = require(path.resolve(__dirname, '..', 'helpers'));
var args      = require('yargs').argv;
var fs        = require('fs');
var clc       = require('cli-color');

module.exports = {
  'migration:create': {
    descriptions: {
      'short': 'Generates a new migration file.',
      options: {
        '--name': 'Defines the name of the migration. ' +
          clc.blueBright('Default: unnamed-migration'),
        '--underscored': 'Use snake case for the timestamp\'s attribute names'
      }
    },

    aliases: [ 'migration:generate' ],

    task: function () {
      var config   = null;

      helpers.init.createMigrationsFolder();

      try {
        config = helpers.config.readConfig();
      } catch (e) {
        console.log(e.message);
        process.exit(1);
      }

      fs.writeFileSync(
        helpers.path.getMigrationPath(args.name),
        helpers.template.render('migrations/skeleton.js', {}, {
          beautify: false
        })
      );

      helpers.view.log(
        'New migration was created at',
        clc.blueBright(helpers.path.getMigrationPath(args.name)),
        '.'
      );
    }
  },

  'migration:create:auto': {
    'descriptions': {
      'short': "Generates new migration files for tables based on differences in the database and sequelizer.",
      'long': (function () {
        return [
          "!!! EXPERIMENTAL !!! - Make sure to review all migrations generated from this tool",
          "",
          "This will compare the physical database against registered models in sequelizer. ",
          "It treats sequelizer as canon, so it uses the following rules to determine migrations:",
          "  * If a column exists in database, but not in sequelizer, creates 'dropColumn()' migration",
          "  * If a column exists in sequelizer, but not in database, creates 'addColumn()' migration",
          "  * If a table exists in database, but not sequelizer, WARNING, unless '--drop' flag is present, in",
          "       which case it will create a 'dropTable()' migration",
          "  * If a table exists in sequelizer, but not in database, do nothing. It is currently assumed that",
          "       Sequelizer.Sync() will handle table creations",
          "",
          "In order to create these, a file 'models.json' needs to exist in the config directory. This should contain",
          "a JSON object looking like:",
          "{",
          "   'models': [",
          "       'path/to/model.js',",
          "       'path/to/another/model.js'",
          "   ]",
          "}",
          "where the paths are relative to where sequelizer is being run."
          ];
      })(),
      options: {
        '--drop': 'By default, this will not generate DROP TABLE statements. If you\'re sure you want that, this flag will generate them also'
      }
    },

    task: function () {
      var results = helpers.auto.generate();
      return results;
    }
  }
};
