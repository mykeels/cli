'use strict';

module.exports = {
  up: function (queryInterface, Sequelize) {
    <% if (query.up && query.up.length) { %>
      return queryInterface
      <% _.each(query.up, function (query) { %>
        <%= query %>
      <% }); %> 
      ;
    <% } %>
  },

  down: function (queryInterface, Sequelize) {
    <% if (query.down && query.down.length) { %>
      return queryInterface
      <% _.each(query.down, function (query) { %>
        <%= query %>
      <% }); %> 
      ;
    <% } %>
  }
};
