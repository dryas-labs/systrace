// SPDX-License-Identifier: Apache-2.0
package Vehicle {
    private import Definitions::*;
    private import Power::*;
    part def Drone :> Component {
        part battery : Battery;
        part motor : Motor;
        interface batteryToMotor : PowerInterface connect
            supply ::> battery.power to consumer ::> motor.powerIn;
    }
}
