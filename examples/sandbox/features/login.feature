Feature: Login with valid credentials

  AC-1: A registered user who submits their correct email and password is signed in

  Scenario: AC-1 Successful login with valid credentials
    Given I am on the login page
    When I submit valid registered email and correct password
    Then I am signed in and the account menu shows my email address and offers Logout

  Scenario: AC-2 Invalid password shows generic error message
    Given I am on the login page
    When I submit a valid email with an incorrect password
    Then I remain on the login page and see "Invalid email or password."
    And the message does not reveal whether the email or password was wrong

  Scenario Outline: AC-3 Log in button is disabled while fields are empty
    Given I am on the login page
    When I touch the "<field>" field and leave it empty
    Then the Log in button is disabled
    And I see the message "<message>"

    Examples:
      | field    | message                           |
      | email    | Please provide an email address.  |
      | password | Please provide a password.        |

  Scenario: AC-4 Unregistered email produces same error as wrong password
    Given I am on the login page
    When I submit an unregistered email with any password
    Then I see "Invalid email or password."
    And the response does not disclose whether an account exists
