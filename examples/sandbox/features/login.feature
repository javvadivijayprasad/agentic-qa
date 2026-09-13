# Sandbox fixture: mirrors Azure DevOps work item AB#1 "Login with valid
# credentials" (AC-1 … AC-4) in the agentic-qa-sandbox project. Used to exercise
# bdd2pw and pw without touching Azure DevOps:
#
#   aqa run "…" --workspace examples/sandbox --dry-run
#
Feature: Login with valid credentials

  Background:
    Given the login page is open

  Scenario: AC-1 a registered user with correct credentials reaches the dashboard
    When the user signs in with a valid username and password
    Then the dashboard is displayed
    And the user's name is shown in the header

  Scenario: AC-2 an incorrect password is rejected without revealing which field failed
    When the user signs in with a valid username and a wrong password
    Then the message "Invalid username or password" is displayed
    And the user stays on the login page

  Scenario: AC-3 the account locks after five consecutive failures
    Given the user has failed to sign in four times
    When the user signs in with a wrong password
    Then the message "Account locked" is displayed

  Scenario Outline: AC-4 required fields are validated before any request is sent
    When the user signs in with "<username>" and "<password>"
    Then the message "<message>" is displayed

    Examples:
      | username | password | message              |
      |          | secret   | Username is required |
      | alice    |          | Password is required |
      |          |          | Username is required |
