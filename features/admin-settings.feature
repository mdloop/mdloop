Feature: Admin-only organization settings
  Org settings — retention, purge behavior, sharing mode, member roles — are
  admin-only operations (CONSTITUTION.md §4).

  Background:
    Given an organization "Acme" with admin "alice" and member "mia"

  Scenario: A member cannot change retention settings
    When "mia" attempts to set retention to 7 days
    Then the request is forbidden
    And the organization retention remains 30 days

  Scenario: An admin can change retention settings
    When "alice" sets retention to 7 days
    Then the organization retention is 7 days

  Scenario: An admin can enable immediate purge
    When "alice" enables immediate purge
    Then deleted documents become purgeable immediately

  Scenario: A member cannot change another member's role
    When "mia" attempts to promote herself to admin
    Then the request is forbidden

  Scenario: An admin can promote a member
    When "alice" promotes "mia" to admin
    Then "mia" has the admin role

  Scenario: An admin cannot demote themselves
    When "alice" attempts to demote herself to member
    Then the request is rejected as self-demotion
